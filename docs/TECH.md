# Tech

> Owner: developer. Stack, folder structure, conventions, how to run and test.
> Status: **Phase 0 in progress.** Plan approved by owner. Test phones: **Google Pixel 10** and **Samsung Galaxy S24 (SM-S9210)**, both Android Chrome (section 4.3). 0.1 tested on the Pixel 10; 0.2/0.2.1 tested on the Galaxy S24 ("strum counting and the tuner work fine"), first real recording **rec1** analysed. **0.3 (chord classification, plus the rec1 fixes for double triggers and the noise floor) built, pending owner test.**
> Last updated: 2026-10-06

**How to read this doc:** Sections marked **(Plain English)** are written for the owner. Sections marked **(Technical)** are for the developer. You can skip those without missing any decisions.

---

## 0. Summary (Plain English)

**Goal of Phase 0:** prove that a phone can listen to a real guitar and correctly tell which of four chords was strummed (**Am, C, G, D**), and when. For every strum, the prototype reports:

- **which chord** it heard (or "unsure"),
- **when** the strum happened (a timestamp), and
- **how confident** it is (0–100%).

**Recommendation:** build the prototype as a **web page** that you open on your phone from a link. You install nothing, there is no app store, and each update is live a minute after the developer publishes it. The detection logic will be written so it can move to the final game engine, whichever engine that turns out to be. The engine choice for the real game is **still open** (see section 1.4).

**What Phase 0 does NOT decide:** game rules, scoring, levels, look and feel. Those belong to the game-director (`docs/GAME_DESIGN.md`). This prototype only answers the question "can we hear the chords reliably and quickly enough?"

---

## 1. Platform for the prototype: web page vs. Unity

### 1.1 Recommendation (Plain English)

**Build Phase 0 as a mobile web page.** Reasons:

| | Web page | Unity app |
|---|---|---|
| Getting it onto your phone | Open a link | Build, sign, then install via TestFlight (iPhone) or an APK file (Android) |
| Time from a code change to you testing it | ~1–2 minutes | ~15–60 minutes, plus Apple review/signing steps on iPhone |
| Works on iPhone and Android | Yes, same link | Yes, but two separate builds |
| Microphone quality and latency | Good on modern phones if set up correctly | Built-in mic support is mediocre; good results need native plugins |
| Cost | Free hosting | Practically needs a paid Apple developer account ($99/yr) for TestFlight; free accounts can only install from a Mac via Xcode, and the app expires after 7 days |
| Carries over to final game | The **method, settings and test recordings** do. The code might be rewritten (see 1.4) | If the final game is Unity, more code carries over |

Phase 0 is mostly about experimenting: adjusting thresholds and trying ideas many times a day. The web wins on speed for that. The one hard requirement is that the page must be served over **HTTPS** (a secure link), because browsers only allow microphone access on secure pages. Free hosts such as GitHub Pages provide this automatically.

### 1.2 Web: phone browser quirks (Technical)

- **Secure context:** `navigator.mediaDevices.getUserMedia` only works on `https://` or `http://localhost`. Phone testing therefore needs a deployed HTTPS URL, or a dev server with a self-signed cert / tunnel.
- **User gesture:** `AudioContext` starts `suspended` on iOS Safari and usually on Chrome too. Create or `resume()` it inside the Start button's click handler. iOS also suspends or interrupts audio when the tab goes to the background, the screen locks, or a phone call arrives, so handle `statechange` and show a "tap to resume" button.
- **Turn off voice processing:** request
  `{ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } }`.
  With these left on (the defaults), the browser treats the guitar as noise or echo, gates sustain, and pumps the volume, which damages both onset and chroma. Support varies: iOS Safari honours `echoCancellation:false` (it switches off the voice-processing I/O unit), and `noiseSuppression`/`autoGainControl` may be ignored. Log `track.getSettings()` on screen so we know what each device actually applied.
- **Sample rate:** do not force a sample rate. Read `audioContext.sampleRate` (typically 48 000 Hz on iOS and most Android, sometimes 44 100) and make every DSP parameter derive from it. On older Safari, forcing a `sampleRate` that differs from the hardware rate has caused silent or garbled input.
- **AudioWorklet:** supported on iOS Safari 14.5+ and Chrome 66+. Use it for capture (render quantum = 128 frames, about 2.7 ms). Do not use the deprecated `ScriptProcessorNode`.
- **Speaker + mic at the same time (iOS):** while the mic is open, iOS may lower playback volume or route it differently. Metronome clicks played from the speaker **will be picked up by the mic** (echo cancellation is off). See section 3.4 and Risk R3.
- **Wake lock:** use the Screen Wake Lock API where available so the screen doesn't sleep mid-test.

### 1.3 Unity: microphone and build friction (Technical)

- The built-in `Microphone.Start()` records into a looping `AudioClip`, which you poll with `Microphone.GetPosition()`. You copy samples out with `clip.GetData()` on the main thread, which is tied to the frame rate and adds jitter. Typical added input latency is around 30–100+ ms and varies a lot on Android. Exact sample-accurate timestamps are awkward.
- Serious music or rhythm games on Unity usually add a **native plugin**: Oboe/AAudio on Android, and AVAudioEngine / Audio Unit (RemoteIO) with `AVAudioSession` set to `.measurement` mode on iOS to disable voice processing. Third-party store assets exist, or we write our own thin plugin. Either way it is extra native work per platform.
- Build friction: an iOS build needs a Mac + Xcode, signing certificates and TestFlight. Android needs an APK/AAB and sideloading or Play internal testing. Each change takes minutes to hours to reach the phone, compared with seconds on the web.

### 1.4 Carrying the detection logic over to the final game (Technical, with a plain-English summary)

**Plain English:** whichever engine the final game uses, the valuable output of Phase 0 is (a) the **recipe** (the detection method), (b) the **tuned numbers** (thresholds and window sizes), and (c) a **library of labelled guitar recordings** that any future version must pass. The program code itself may get rewritten for the final engine, and that is fine, because the recordings let us prove the rewrite behaves the same way.

How we make that true:

1. **Pure DSP core, no platform dependencies.** `detection/` takes in arrays of float samples plus a sample rate and returns `{chord, time, confidence}` events. It has no DOM, no Web Audio, and no timers. It can then run in a browser, in Node (for tests), or be translated line-for-line.
2. **Golden test set.** Labelled WAV clips with a matching labels file listing the expected onset times and chords. An automated test runs the detector on all clips and reports accuracy and timing error. **Any port (C#, C++, Rust…) must hit the same scores on the same clips.** This is the real contract.
3. **All tunables in one config file** (`detection/config.ts`) with units in the names (`minInterOnsetMs`, `chordWindowStartMs`, …), so the parameters can be copied exactly.
4. **Porting options when the engine is chosen:**
   - *TypeScript → C# port* (if Unity): the core is small (a few hundred lines: FFT, onset, chroma, templates), so a hand port checked against the golden set is realistic.
   - *Shared C/C++ or Rust core*: compiled to WebAssembly for web and to a native plugin for Unity/iOS/Android. One codebase, but a heavier toolchain. Worth it only if the final game ships on several engines or the core grows (for example an ML model).
   - *Stay on web* (e.g. a PWA, or a Capacitor wrapper for the stores): the code carries over directly.
5. We deliberately **do not** pick the final engine now. **The final engine choice is open.** It belongs to the game design and should be logged in `docs/DECISIONS.md` once the game-director and owner decide. Phase 0 results (especially measured web latency) are an input to that decision.

---

## 2. Detection approach

### 2.1 How it works (Plain English)

1. **Listen for a strum.** The program watches for a sudden burst of new sound, the "attack" when the pick or fingers hit the strings. That moment is the strum's **timestamp**.
2. **Wait a moment, then listen to the notes.** The first few hundredths of a second after a strum are mostly scratchy pick noise. The program skips that and listens to the ringing notes for about a tenth of a second.
3. **Compare against the four chords.** It works out which musical notes (A, B, C, D, E, F#, G…) are loudest, then compares that "note fingerprint" to the fingerprints of Am, C, G and D.
4. **Decide, with a confidence score.** If one chord matches clearly better than the others, it reports that chord with a high confidence. If two chords match about equally well, or nothing matches, it reports **"unsure"** instead of guessing.

Because there are only **four** possible answers, the task is much easier than general chord recognition. The detector only needs to tell four known fingerprints apart.

### 2.2 Onset (strum) detection (Technical)

- **Front end:** mono float input, STFT with frame size N=1024 (~21 ms @48 kHz), hop H=256 (~5.3 ms), Hann window.
- **Onset function:** half-wave-rectified **spectral flux** on log-compressed magnitudes (`log(1 + γ·|X|)`), optionally weighted toward higher bins (high-frequency content, HFC). Strum attacks are broadband and bright, while sustained notes are not, so HFC weighting suppresses retriggers from ringing strings.
- **Adaptive threshold:** `threshold[n] = δ + λ · median(odf[n−a … n+b])`, plus an absolute floor tied to the mic noise level measured at start-up.
- **Peak picking:** local maximum within ±w frames, above threshold. Lookahead b ≈ 2–3 hops (~10–16 ms) of added detection delay.
- **Minimum inter-onset interval:** e.g. 60–100 ms, so a single strum that hits six strings over 20–40 ms gives **one** event, not six. Down-up strumming patterns are in scope (owner answer, 2026-10-05): at 120 BPM, eighth-note down-up strums are 250 ms apart and sixteenths 125 ms, so the interval must stay well below ~120 ms. Each event also records **strum direction (down/up)** where it can be estimated (low strings first = down, high strings first = up), as a stretch goal.
- **Timestamp:** the onset frame's sample index, refined back toward the start of the energy rise (e.g. the first frame above 50% of the peak flux). The time is the **sample count**, not wall-clock (see section 3.2).
- **As built in 0.2** (`src/detection/onset.ts`, all numbers in `onsetConfig`): magnitudes normalised so a full-scale sine = 1, `log(1 + 1000·|X|)`, bins 60 Hz–10 kHz with weight `1 + f/10 kHz` (normalised to sum 1). Flux compares each frame with the frame **2 hops earlier** (`fluxLagFrames`): a real strum hits the strings one after another over 20–40 ms, and lag-1 flux split that rise into several weak peaks (a synthetic 6-string strum spread over 30 ms was missed 4 times in 12). Threshold `0.10 + 1.5 · median(odf over the past 100 ms + lookahead)`; the peak must be the max over −16/+16 ms (16 ms lookahead). **Absolute floor** = a separate level gate: frame RMS around the peak must be ≥ room floor (from the 0.1.1 noise-floor tracker, sent to the worklet whenever it changes) + `minAboveRoomDb` (10 dB). Before the room is measured the gate is off. Min gap 70 ms (first strum wins; replaced by the 110 ms merge window in 0.3, see below). **Timestamp refinement:** in the 50 ms before the end of the peak frame (never before the previous strum + min gap), the first 1 ms block where the energy of `x[n] − x[n−1]` (an attack/pick-noise envelope) rises above `min + 0.2·(max − min)`. Each event: `{ sampleIndex, timeSec, strength (ODF peak), levelDb }`. Direction (down/up) is not attempted yet.
- **Changed in 0.3 after rec1 (Galaxy S24): strum merging.** On the real guitar, 0.2.1 reported 35 events for 20 strums: a slow strum hits the strings over ~100–140 ms and gives an ODF peak every ~20–30 ms, so "first wins + 70 ms gap" fired again on the first peak after the gap (pairs exactly 70 ms apart). Now every candidate peak (threshold + level gate passed) within `minInterOnsetMs` (**110 ms**, the "Strum merge window" slider) of the first candidate belongs to the same strum. The strum is emitted once no later candidate can join (its refined onset could no longer fall in the window). Its **time** is the first candidate whose level is within `strumLevelSpanDb` (12 dB) of the loudest one, so a quiet precursor (finger noise) is skipped; strength/level are the maxima. Exception: a candidate `splitStrengthRatio` (2.5×) stronger than the first starts a new strum. Down-up strums 125 ms apart stay separate (tested, including multi-string up/down strums). rec1: **35 → 22 events, 20/20 strums found, 2 extras** (a −28 dB brush 154 ms before one strum, and one chord-change noise). Cost: the strum is reported ~160–175 ms after its onset instead of ~40 ms; the timestamp is unaffected, and the chord needs that long anyway. Also changed: the timestamp refinement's baseline is now the median of the first half of the search window instead of its minimum (more robust while the previous chord rings). The `refineOnset` search never goes before the previous candidate. `flush()` emits the last strum at the end of a file. **Known limits:** a quiet first string (low E behind the 70 Hz high-pass) is not detected on its own, so very slow strums are timed 20–40 ms after it; soft up-strums much weaker than the ringing down-strum can be missed (threshold, not merging).
- **Synthetic results (unit tests):** irregular plucks over −50 dBFS noise, amplitudes varying by 11 dB: 40/40 found, 0 extra, max timing error 0.7 ms. 125 ms down-up spacing (loud/soft alternating, also same pitch): 48/48, no merges or doubles. 6-string 30 ms strum: 12/12, timed at the first string (< 10 ms). Noise, noise swelling +30 dB over 6 s, a fading-in tone, 30/50 Hz rumble with 25 Hz modulation: 0 triggers. Noise with the level gate off: 0 in 5 minutes (noise ODF max 0.07 vs threshold ~0.17). **Synthetic signals are much easier than a real guitar**: the real numbers come from the owner's recordings.

### 2.3 Chord recognition (Technical)

- **Analysis window:** start ~30 ms after the onset (skipping the pick transient) and run to ~130 ms (configurable `chordWindowStartMs` / `chordWindowEndMs`). Average several overlapping frames in that span.
- **Chroma / pitch class profile (PCP):** FFT with N=4096 (~85 ms) or N=8192 with zero-padding, fold magnitude bins between ~75 Hz and ~2 kHz into 12 pitch classes (A4 = 440 Hz reference, ±50 cents per class, with optional tuning offset estimation). Log-compress, then L2-normalise. A CQT gives better low-frequency resolution but costs more. Start with FFT-chroma and compare against Meyda/Essentia.
- **Templates with harmonic weighting:** for each chord, build a 12-bin template from its notes **including the first few harmonics** (each note's 2nd, 3rd, 4th partials with decaying weights such as 1, 0.6, 0.4, 0.3), because a guitar's E3 also puts energy at B4 and so on. Better still, build templates from the **actual open-position voicings** below, since we know exactly which strings sound.
- **Score:** cosine similarity between the measured chroma and each template.
- **Confidence:** combine the best similarity `s1` with the margin over the second best `s1 − s2`. For example `confidence = clamp((s1 − sMin)/(1 − sMin)) · clamp((s1 − s2)/marginFull)`. Report **"unsure"** if `s1 < minSimilarity` or `s1 − s2 < minMargin`. The exact formula will be fitted on recorded data. Confidence should be *calibrated*: of the strums reported at 80% confidence, about 80% should be correct.

**As built in 0.3** (`src/detection/chroma.ts`, `chords.ts`, `classifier.ts`; all numbers in `chordConfig`):
- *Window:* one Hann window over **50–160 ms after the onset** (`chordWindowStartMs/EndMs`) of the high-passed analysis signal, zero-padded to an **8192-point FFT** (5.9 Hz bins at 48 kHz; 4800–5280 samples of signal). A single long window replaced "average several frames": the window is barely longer than one 4096 frame anyway. Moved from the planned 30–130 ms after rec1: slow strums are still building up at 30 ms.
- *Chroma:* only **spectral peaks** (local maxima, `peaksOnly`) between 75 Hz and 2 kHz are folded into 12 pitch classes (A4 = 440 Hz), each weighted by cos² of its distance from the semitone centre; then `log(1 + 3·c/max c)` and L2 normalisation. *Bass chroma:* the same over 75–170 Hz.
- *Templates:* from the exact voicings in the table below (MIDI notes), each note plus partials 1–6 with weights 1, 0.6, 0.4, 0.3, 0.2, 0.15 inside the fold range; bass templates use partials in 75–170 Hz with the lowest note weighted 2×.
- *Score:* `0.9·cos(chroma, T) + 0.1·cos(bass, B)` (`bassWeight` 0.1, only if there is bass energy). *Confidence:* `clamp((s1 − 0.7)/0.3) · clamp((s1 − s2)/0.2)`. **"?"** if `s1 < 0.70`, `s1 − s2 < 0.05`, or the window is less than 6 dB above the room. Discriminative weighting and per-player templates are not done yet (0.4).
- *Synthetic tests (exact voicings, harmonic strings, pick noise):* all four chords named with > 50% confidence; ±15 cents detune, 3 and 15 ms per-string spread, bass strings −10 dB, 48 and 44.1 kHz: ≥ 95% correct and 0 wrong-named; Am vs C and G vs D separated by more than the margin; noise and too-quiet strums give "?"; a full Am/C/G/D ×5 progression through the whole streaming chain (onsets + chords) gives 20/20 strums and 20/20 chords.
- *rec1 result (Galaxy S24, real guitar, no calibration):* **C/G/D: 12/15 correct, 3 "?", 0 wrong** (best guess right on 15/15). The five strums meant to be Am are actually **E minor** (B2 E3 G3 B3 E4, no A or C in the spectrum): 4 × "?" and 1 × G at 30%. **Am vs C has therefore not been checked on real audio yet.** Details: section 7a.

**Open-position voicings (standard tuning, assumed):**

| Chord | Shape | Notes sounding (low → high) | Lowest note | Unique pitch classes |
|---|---|---|---|---|
| Am | x02210 | A2 E3 A3 C4 E4 | A2 (110 Hz) | A, C, E |
| C | x32010 | C3 E3 G3 C4 E4 | C3 (131 Hz) | C, E, G |
| G | 320003 | G2 B2 D3 G3 B3 G4 | G2 (98 Hz) | G, B, D |
| D | xx0232 | D3 A3 D4 F#4 | D3 (147 Hz) | D, F#, A |

**The confusable pairs, and how we handle them:**

- **Am vs C** share C and E. The only differing note is A (Am) vs G (C).
- **G vs D** share D. The differing notes are G and B (G) vs A and F# (D).
- Mitigations:
  1. **Discriminative weighting:** give templates extra weight on the notes that separate confusable chords (A vs G, B vs F#). B appears only in G and F# only in D, so those are strong cues.
  2. **Bass-note weighting:** each chord has a different lowest note (A2, C3, G2, D3). Compute a separate "bass chroma" from roughly 75–180 Hz and add it as a weighted term. Bass needs better frequency resolution (a semitone at 100 Hz is only ~6 Hz wide), so use a longer window (N=8192) or harmonic-sum pitch estimation for the bass term only. Bass strings also dominate less on phone mics, so this term is a tiebreaker, not the main signal.
  3. **Per-player calibration:** in a short setup step the player strums each chord ~5 times. We store the average chroma per chord as **that player's template** (blended with the theoretical template). This absorbs differences in guitar, strings, mic, room, voicing and strumming style, and is likely the single biggest accuracy gain.
  4. **"Unsure" instead of guessing** when the margin is small.

### 2.4 Libraries (Technical)

| Library | What it offers | Licence | Use in Phase 0 |
|---|---|---|---|
| **Meyda** (JS) | Real-time features incl. chroma, spectral flux, RMS | MIT | **Reference/comparison** for our chroma. Safe to ship |
| **Essentia.js** (WASM) | Onset detection, HPCP (high-quality chroma), chord detection | **AGPL-3.0** (commercial licence available from UPF/MTG) | **Offline comparison only**, never shipped. AGPL would require releasing our whole game's source code if distributed or served to users, unless we buy a commercial licence |
| **aubio** (C) | Mature onset/pitch detection | **GPL-3.0** | Reference for onset ideas only. GPL is also a problem for a closed-source commercial game |
| Small FFT (e.g. fft.js, KissFFT, pffft) | FFT only | MIT / BSD | **Use one** of these inside our core |

**FFT as built (0.2):** a hand-written iterative radix-2 complex FFT (`src/detection/fft.ts`, ~60 lines, our own code, so no licence question), checked against a direct DFT in the tests. No FFT library dependency was needed.

**Recommendation:** **hand-roll a small DSP core** (FFT via a permissive library, spectral-flux onsets, FFT-chroma, template matching). Reasons: (1) it is small and fully understood, which makes it easy to tune and to port; (2) no licence risk for a commercial game; (3) no heavy WASM blob to load on phones. Use Meyda (and Essentia.js in a dev-only tool) to **cross-check** our numbers on the golden clips.

**Later option, ML:** if templates plus calibration plateau below target, train a **tiny classifier** (e.g. logistic regression or a small CNN over a few chroma/log-spectrum frames, 5 outputs including "none") on the labelled recordings. It is still small enough to port (ONNX, or hand-written inference). We only do this if the data shows it is needed, and the golden set we are building now is exactly the training data it would need.

### 2.5 Where the strum detector runs (Technical, decided in 0.2)

**In the capture AudioWorklet** (audio thread), on the high-passed analysis signal, right after the filter.
- *Cost, measured:* 60 s of 48 kHz audio in ~430 ms in Node on one 2.1 GHz Xeon core: **~19 µs per 128-frame quantum, 0.7% of the 2.67 ms budget** (one 1024-point FFT every 2 quanta). Even if a phone core is 10x slower that is ~7%. `push()` allocates nothing in steady state (preallocated buffers, insertion-sort median), so there is no garbage-collection pressure on the audio thread.
- *Why not the main thread:* the worklet would have to post every sample (~375 messages/s), and detection would stall whenever the UI is busy. *Why not a Web Worker:* extra MessageChannel plumbing for no gain at this cost. Revisit for chroma (0.3, N=4096–8192) if it turns out heavier; a Worker is the fallback.
- *Timeline:* the detector's sample counter equals the worklet's `framesProcessed` (both start at 0 at Start and see every frame), so `sampleIndex / sampleRate` = seconds since Start on the audio clock. Recording chunks carry the same frame index, so events are placed exactly in the WAV (verified: offline detection on an exported WAV reproduced the live events to 0.0 ms).
- *Messages:* main → worklet: `onset-settings` (live sliders), `noise-floor` (on change), `record` on/off. Worklet → main: `level` (as before), `onset`, `raw` (4096-frame chunks, transferred, only while recording), `record-stopped`.
- *0.3:* the worklet runs a `StrumTracker` (`src/detection/strum.ts`): the onset detector plus a 1.2 s history of the analysis signal. Each `onset` message is posted once the strum is confirmed **and** its chord window has arrived, and carries `audio` (onset → onset + 160 ms, ~7700 floats, transferred). Measured in Node: ~31 µs per quantum (rec1), and nothing is allocated per quantum except when a strum is handed over.

### 2.7 Where chord classification runs (Technical, decided in 0.3)

**On the main thread, on the audio that comes with each strum message.**
- *Why not the worklet:* one 8192-point FFT per strum is ~1 ms of JS. That is fine on average, but it would land inside a single 2.67 ms audio quantum, risking a dropout on a slower phone. Strums are rare (≤ ~8/s), so the main thread has plenty of time, and the timestamp still comes from the audio clock.
- *Why not a Worker:* it is not needed at this cost (measured ~1.2–1.4 ms per strum in headless Chromium). A Worker remains the fallback if phones show jank.
- *Latency:* the strum message arrives 161–175 ms after the onset (rec1: the 110 ms merge window, then the 160 ms chord window), plus ~1 ms classification and the next animation frame. Total ~180–200 ms plus mic input latency, within the 250 ms target in 4.2.
- *Offline:* `detectStrumsInAnalysis` in `pipeline.ts` runs the identical chain (tracker, then classifier) for tests, `npm run evaluate` and the rec1 analysis.

### 2.6 Tuner pitch detection (Technical, added in 0.2.1)

**Method: McLeod Pitch Method (MPM)**, `src/detection/pitch.ts`, on the same high-passed analysis signal the strum detector uses, plus a 1 kHz low-pass (2 x 2nd-order Butterworth, `pitchConfig.lowPassHz/lowPassStages`) that removes hiss while keeping every open string's fundamental and first harmonics.
- *Window/hop:* 4096 samples (85 ms at 48 kHz, 93 ms at 44.1 kHz; about 7 periods of low E) every 1024 samples (~21 ms). Lags searched: `minHz` 60 to `maxHz` 420 Hz.
- *NSDF* n(τ) = 2r(τ)/m(τ): r(τ) from one zero-padded 8192-point FFT (|X|², then a second forward FFT), m(τ) from a running sum. Parabolic interpolation on the chosen peak gives sub-sample period; **clarity** = interpolated peak height (0..1).
- *Octave errors:* MPM picks the first NSDF "key maximum" ≥ `peakThreshold` (0.9) x the highest one. At half the period the fundamental and odd harmonics are out of phase, so a strong 2nd harmonic does not win. Synthetic tests: no octave errors even with the fundamental 12x weaker than the 2nd harmonic (worst error 0.6 cents). When the player locks a string, the detector takes the clear peak nearest that string's pitch, which rules out octave jumps entirely for that string.
- *Silence gate:* window RMS must be ≥ room noise floor + `minAboveRoomDb` (10 dB) and ≥ `minLevelDb` (−70 dBFS); clarity must be ≥ `minClarity` (0.8). Noise and silence give no reading (tested).
- *Tuning logic* (`src/detection/tuner.ts`): standard tuning E2 A2 D3 G3 B3 E4 from `tunerConfig.a4Hz` (440, configurable). Nearest string (or the locked one), cents = 1200·log2(f/target), in tune if |cents| ≤ `inTuneCents` (5). **Smoothing:** a new string must win `switchFrames` (3) readings in a row; median of the last 5 readings then EMA (α 0.35); the last value is held `holdMs` (1.5 s) when the note fades. A chip turns green after `inTuneFrames` (6, ~130 ms) in-tune readings in a row and stays green for `inTuneMemoryMs` (90 s).
- *Where it runs: main thread.* While the Tuner is open, the worklet posts its high-passed audio in 1024-frame chunks (transferred, ~47 messages/s, `tap` control message); otherwise nothing extra crosses threads. Measured cost: **~0.7 ms per frame in Node (3.2% of one core in real time)**; ~0.3–0.65 ms per frame in headless Chromium. Even 4x slower on a phone it is ~3 ms every 21 ms, and a late frame only delays the needle (the tuner does not need sample-exact timing, unlike strums). Keeping it off the audio thread means a heavier analysis can never cause audio dropouts or disturb the strum detector. A Web Worker is the fallback if the phone shows UI jank.
- *Strum detector unaffected:* it keeps running in the worklet in both modes. Strums detected while the Tuner is open still go into the recording's JSON but are not added to the strum counter/log.

---

## 3. Latency

### 3.1 What "latency" means here (Plain English)

There are two separate delays:

- **When the strum is recorded as happening.** This must be **accurate** (within a few hundredths of a second) so timing can be judged fairly. We can make this accurate even if the computer is slow, because we read the time from the audio itself.
- **When the screen shows which chord it was.** This can be a little later (about 0.1–0.2 s) because the program needs to hear the notes ring for a moment. For a game this means "the strum lands on the beat" is judged precisely, and the "it was a C" feedback appears a fraction of a second later.

Every phone model has its own built-in delay, so the prototype includes a **calibration step** to measure and cancel it.

### 3.2 Budget (Technical, estimates to be measured in Phase 0)

| Stage | iOS Safari (recent iPhone) | Android Chrome (mid/high-end) | Notes |
|---|---|---|---|
| Mic hardware + OS input buffer | ~5–15 ms | ~10–40 ms (some devices 80+ ms) | Varies most on Android. Measured by calibration |
| Worklet quantum / block handoff | ~3–10 ms | ~3–10 ms | 128-frame quanta, batched to main/worker |
| Onset detection (frame + lookahead) | ~15–30 ms | ~15–30 ms | N=1024 frame, 2–3 hop lookahead |
| **Onset known** (sum) | **~25–55 ms** | **~30–80 ms** | Timestamp itself is corrected back to the true onset |
| Chord window (after onset) | +130 ms | +130 ms | `chordWindowEndMs`, tunable 80–200 ms |
| Display (next frame + screen) | ~16–40 ms | ~16–50 ms | |
| **Chord shown on screen** | **~170–230 ms after strum** | **~180–260 ms after strum** | Acceptable for feedback. Timing is judged from the onset timestamp |
| Output (speaker) latency, for click/music | ~10–30 ms | ~20–80 ms | Relevant for metronome and game music sync |

### 3.3 Strategies (Technical)

- **Timestamp from the audio clock, not when detection finishes.** The worklet counts frames (`currentFrame` inside `AudioWorkletGlobalScope`). Onset time = `onsetSampleIndex / sampleRate`, on the same timeline as `AudioContext.currentTime`. The chord can then be decided ~130 ms later while the event still carries the correct strum time.
- **AudioWorklet** for capture (off the main thread, no UI-induced dropouts). DSP runs either in the worklet (onset, cheap) or a Web Worker (chroma). Start simple and measure CPU first.
- **Per-device latency calibration**, measured in the prototype:
  1. *Loopback test:* play clicks through the speaker and detect them in the mic. This gives round-trip (output + input) latency with no human involved.
  2. *Strum-along test:* the player strums along to a click/flash for ~16 beats. The median offset between scheduled beats and detected onsets = system latency + the human's habit. Store the offset per device and subtract it.
  3. Show both numbers on screen and in the export so we learn how much devices vary.
- **Bluetooth headphones/speakers warning:** Bluetooth output adds roughly 100–300 ms and varies, which breaks audio-to-strum sync. Bluetooth mics (headsets) are low quality and also add delay. The prototype will warn if a Bluetooth route is detected (where the browser exposes it) and the test instructions say to avoid Bluetooth.

### 3.4 Metronome bleed (Technical)

With echo cancellation off, the phone mic hears the metronome. Mitigations, to be tried in this order: a visual-only beat (flash), or a quiet short click plus **ignoring onsets within ±15 ms of a scheduled click** that have click-like spectra, or wired headphones. This matters a lot for the final game if it plays music while listening (see the questions in section 8).

---

## 4. Prototype scope and success criteria

### 4.1 Screens and features (Plain English)

One page, with these parts:

1. **Start button.** Asks for microphone permission and starts listening.
2. **Mic level meter.** A bar that moves when there is sound, so you can see the phone is hearing the guitar and isn't overloaded (it turns red when too loud).
3. **Live chord display.** A big chord name (Am / C / G / D / "?") with a confidence percentage, flashing on each strum.
4. **Event log.** A scrolling list: time, chord, confidence for each detected strum.
5. **Settings sliders** (in a "Developer" drawer). Sensitivity (onset threshold), minimum gap between strums, "unsure" cut-off. You can leave them alone; they help when we troubleshoot together.
6. **Calibration.** (a) A latency test (clicks and strum-along), and (b) a "teach it my guitar" step: strum each chord 5 times when asked.
7. **Test mode.** Plays a metronome and shows which chord to strum on each beat. Afterwards it shows a score: % chords correct, average timing error, missed strums and false triggers.
8. **Record and export.** Records the raw audio of a session plus the detected events, and lets you share or download them (audio as a `.wav` file, results as a `.json`/`.csv` file).
9. **Device info panel.** Phone/browser, sample rate, which mic settings were actually applied, measured latency. Included in every export.

### 4.2 Success criteria (measurable)

Measured on the golden recordings **and** live on the target phones:

| Metric | Target to pass Phase 0 |
|---|---|
| Correct chord on clean, full strums (per chord, after "teach it my guitar") | **≥ 90%** (stretch: ≥ 95%) |
| Correct chord without per-player calibration | Report it. ≥ 80% is a good sign |
| Strums detected (recall) | ≥ 95% |
| Wrong chord reported with confidence ≥ 80% | ≤ 3% of strums |
| Onset timing error after latency calibration | median < 15 ms, 95th percentile **< 30 ms** |
| False triggers in a quiet room, guitar not played (incl. string ringing, handling noise) | **< 1 per minute** |
| Chord result on screen after the strum | ≤ 250 ms |
| Progression at medium tempo (e.g. 90 BPM, one strum per beat) | ≥ 90% correct chords |
| Strumming pattern (e.g. D-DU-UDU at 80 BPM, one chord per bar) | ≥ 90% of strums detected, ≥ 85% correct chords, no double/missed events on up-strums |
| Runs smoothly | No audio dropouts over a 5-minute session |

### 4.3 Target devices

- **The owner's two Android phones, in Chrome** (confirmed 2026-10-06). Results are labelled per device:
  - **Google Pixel 10**: 0.1 test (48 kHz, base latency 5 ms, reported mic latency 40 ms, processing off).
  - **Samsung Galaxy S24 (SM-S9210)**, Android 16, Chrome 154: 0.2/0.2.1 test and recording rec1 (48 kHz, base latency 4 ms, output 23 ms, reported mic latency 40 ms, processing off). The UA string says "Android 10; K" (Chrome's reduced UA). The model comes from UA client hints.
  - Earlier notes assumed every test was on the Pixel 10. Only 0.1 was.
- Android mic delay varies a lot between models, so the latency calibration (0.4) must be run on both.
- iPhone/Safari is **not** a Phase 0 target. The code avoids anything Android-only so iPhone can be added later.
- Guitar: the owner's guitar (acoustic assumed) in standard tuning.

---

## 5. Proposed stack and folder structure (Technical)

- **Language/build:** TypeScript + **Vite**, with **no UI framework** (plain DOM; the UI is small).
- **Audio:** Web Audio API + **AudioWorklet** (`getUserMedia` with processing disabled).
- **Tests:** **Vitest** in Node. `detection/` is DOM-free and is tested against WAV fixtures. A small WAV reader is used in tests only.
- **Tunables:** one file, `src/detection/config.ts`. The UI sliders override values at runtime, and an "export config" button lets good values be copied back into the file.
- **Hosting:** **GitHub Pages** via a GitHub Actions workflow (HTTPS, free, auto-deploys on push to the main branch). Alternative: Netlify. Local dev: `npm run dev` (localhost works on desktop). For a phone on the same Wi-Fi, use `vite --host` with a self-signed HTTPS plugin. The owner will never need this.

```
prototype/                     # Phase 0 web prototype (kept separate from any future game code)
  index.html
  package.json
  vite.config.ts
  src/
    detection/                 # PURE DSP core. No DOM, no Web Audio. Portable.
      config.ts                # ALL tunables, units in names
      fft.ts                   # hand-written radix-2 FFT + Hann window
      pipeline.ts              # offline chain (high-pass + detector + floor) for tests/tools
      evaluate.ts              # onset scoring (recall, precision, timing error)
      onset.ts                 # spectral flux / HFC, adaptive threshold, peak picking
      pitch.ts / tuner.ts      # tuner: MPM pitch detector, standard tuning + display smoothing (0.2.1)
      chroma.ts                # chroma + bass chroma
      chords.ts                # chord templates (voicings, harmonic weights)
      classifier.ts            # cosine match, confidence, "unsure"
      strum.ts                 # StrumTracker: onset detector + chord-window audio per strum (0.3, runs in the worklet)
      types.ts                 # ChordEvent { chord, timeSec, sampleIndex, confidence, scores }
    audio/                     # browser-only glue
      mic.ts                   # getUserMedia, AudioContext resume, settings report
      capture.worklet.ts       # AudioWorklet processor (frame counting, ring buffer)
      recording.ts / wav.ts    # recording buffer + export JSON / WAV encode+decode (pure, tested)
      metronome.ts             # scheduled clicks on the audio clock
    ui/                        # screens: meter, live display, log, sliders, test mode
    main.ts
  test/
    fixtures/                  # golden WAV clips + labels (*.wav, *.labels.json)
    detection.test.ts          # unit tests for the DSP pieces
    golden.test.ts             # runs detector over all fixtures, asserts targets
  tools/
    evaluate.ts                # prints accuracy / timing report for all fixtures
.github/workflows/deploy-prototype.yml
```

**Label format** (draft): `{ "sampleRate": 48000, "device": "...", "events": [ { "timeSec": 1.234, "chord": "C" }, ... ] }`. Test-mode exports produce this automatically (expected chord + beat time), so the owner's test sessions become fixtures.

**Conventions:** small pure functions; every DSP parameter in `config.ts`; the detector is deterministic (same input gives the same output); `npm test` must pass before deploy.

---

## 5a. How to run (developer) (Technical)

All commands run in `prototype/`. Node 20.19+ or 22 (CI uses 22).

| Command | What it does |
|---|---|
| `npm ci` | Install exact dependency versions from `package-lock.json` |
| `npm run dev` | Dev server on http://localhost:5173 (mic works on localhost) |
| `npm test` | Vitest unit tests (Node, no browser) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Typecheck + production build into `prototype/dist/` |
| `npm run preview` | Serve the production build on http://localhost:4173 |
| `npm run evaluate` | Score the strum detector on every `test/fixtures/*.wav` + `*.labels.json` pair (or `npm run evaluate -- <dir>`). Prints recall, precision, bias, median/p95 timing error. Uses `tsx` (MIT, dev only). Prints a message and exits 0 if there are no fixtures |

- **Worklet bundling:** `src/audio/capture.worklet.ts` is imported in `mic.ts` with `?worker&url`, so Vite bundles it (and its imports from `detection/`) into one self-contained file in `dist/assets/`. Do not load it with a plain `new URL('./x.ts', ...)`: that copies the `.ts` file without compiling it.
- **Never import the worklet module from main-thread code.** It calls `registerProcessor`, which only exists on the audio thread. Shared constants go in `audio/messages.ts`.
- `base: './'` in `vite.config.ts` makes asset paths relative, so the same build works at `/` and at the GitHub Pages sub-path `/Music-App/`.
- The build ID shown in the page header (and in "Copy info") is the first 7 characters of `GITHUB_SHA`, or `dev` for local builds. Use it to confirm which version the owner has loaded.
- `window.__micDebug.session` exposes the running `MicSession` in the browser console (debugging and smoke tests).
- **Deploy:** `.github/workflows/deploy-prototype.yml` runs on push to `main` or `claude/gallant-archimedes-8jhys7` (when `prototype/**` or the workflow changes) and on manual dispatch: `npm ci`, `npm test`, `npm run build`, then deploys `prototype/dist` to GitHub Pages. One-time setup: Settings → Pages → Source: "GitHub Actions". To deploy from a non-default branch, that branch must also be allowed in Settings → Environments → `github-pages` → Deployment branches.
- **Smoke test (manual, headless):** run `npm run preview`, then open it in Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, tap Start, and check that "Frames processed" increases, the "Stay quiet..." countdown ends with a "Room noise" number, and the console has no errors. The fake device plays a full-scale beep, so the meter shows red/CLIP. That is expected. **0.2:** the fake beep repeats every 0.5 s, so the strum counter should go up twice per second. Record → Stop → "Share / save files" downloads a WAV + JSON (desktop Linux Chromium has no Web Share, so it uses the download fallback). `window.__micDebug.strums`, `.recording` and `.settings` help scripted checks. **0.2.1:** the fake beep is ~20 ms at ~400 Hz, too short for the tuner to show a note (it gives isolated raw readings in `__micDebug.tuner.lastReading`). For a real tuner check, feed a WAV with `--use-file-for-fake-audio-capture=<file.wav>` (e.g. a synthetic plucked string); the display must show the right string and cents. **0.3:** feed a real guitar WAV (e.g. rec1, kept outside the repo) as the fake mic file; the strum box must show chord names, a confidence, the per-chord score row, and log lines with the chord; `window.__micDebug.chords` gives counts and timing. Record → Stop shows **Save to device** (downloads WAV + JSON) and **Share…**.

### Progress

| Milestone | Status |
|---|---|
| 0.1 Mic + level meter | **Built 2026-10-05.** Unit tests and headless smoke test pass. **Owner test, Pixel 10, Android Chrome (2026-10-05):** echoCancellation / noiseSuppression / autoGainControl all **off**, 48 kHz, mono, base latency 5 ms, mic latency (reported) 40 ms, no dropped blocks, deploy link works. Feedback: "the bar was always moving when I wasn't playing". Expected with processing off and a -60 dB meter scale; addressed in 0.1.1. Not yet reported: lock/unlock resume. |
| 0.1.1 Room noise floor + analysis high-pass | **Built 2026-10-05.** 55 unit tests, typecheck, build and headless smoke test pass. Used on the **Galaxy S24** in the 0.2.1 session: the floor read "−15.2 dBFS at start" (owner was strumming during the measurement) and fell to **−100 dBFS** (the clamp) because blocks of exact digital silence were treated as a quiet room. **Fixed in 0.3** (see Noise floor, Technical). |
| 0.2 Strum detection + record/export | **Built 2026-10-05.** 85 unit tests, typecheck, build pass. Headless Chromium smoke test: fake-mic beeps (every 0.5 s) detected 19/19 in 9.5 s at 0.500 s spacing, flash fires, sliders apply live and reset, Record → Stop → export gives a valid 16-bit mono WAV + JSON, offline re-detection on the WAV matches the live events exactly, no console errors. **Owner test on the Galaxy S24 (2026-10-06):** "strum counting works fine". The first recording, **rec1** (Am/C/G/D × 5), showed **double triggers**: 35 events for 20 strums. **Fixed in 0.3** (strum merging, 2.2). |
| 0.2.1 Built-in guitar tuner | **Built 2026-10-06.** 126 unit tests (incl. all 6 open strings detuned −30/−10/0/+10/+30 cents at 48 kHz and 44.1 kHz with a strong 2nd harmonic, decay and noise: every reading after the attack within ±2 cents (actual worst ≈0.6), right string, no octave errors; silence/noise give no reading), typecheck, build pass. Headless Chromium: Tuner switch reuses the mic session, no console errors; with a synthetic plucked A2 at −10 cents fed as the fake mic file the screen shows "A · String 5 · −10 cents · Tune up ↑"; locking low E shows +490 cents; switching back to Strum check counts strums again (fake beep: 10 in 5 s). The default fake beep (~20 ms bursts at ~400 Hz) gives raw readings (399.6 Hz) but no displayed note, by design (too short to be a held note). **Owner test on the Galaxy S24 (2026-10-06):** "the tuner works fine". |
| 0.3 Chord classification (+ rec1 fixes) | **Built 2026-10-06.** 149 unit tests (chroma, templates, classifier on synthetic exact-voicing strums incl. detune/slow strums/weak bass/44.1 kHz, full streaming chain on an Am/C/G/D ×5 progression: 20/20 strums and chords; slow-strum and multi-string down-up onset tests; noise floor with digital silence and strumming during the measurement), typecheck, build pass. **rec1 offline:** 22 events for 20 strums (was 35), C/G/D 12/15 correct + 3 "?", 0 wrong; the "Am" strums are really Em (4 "?", 1 G). Headless Chromium with rec1 as the fake mic: "Please stay quiet — measuring again" appears, floor settles at −50 dBFS (0.2.1 gave −12.9 on the same input and gated out every strum), chords shown live with confidence and scores, ~1.3 ms per chord, Save to device downloads WAV + JSON with chords, no console errors. **Pending owner test** (Galaxy S24 and Pixel 10). |
| 0.4–0.5 | Not started |

**0.1 code map:** `src/audio/mic.ts` (getUserMedia with processing off, AudioContext created/resumed in the Start click, statechange/visibility handling with "Tap to resume", re-acquiring the mic if the track ended, Screen Wake Lock), `src/audio/capture.worklet.ts` (counts frames, posts sum-of-squares/peak/clip count every `blockSizeFrames`), `src/audio/errors.ts` (friendly error messages), `src/detection/config.ts` + `level.ts` (pure meter maths), `src/ui/meter.ts`, `src/ui/deviceReport.ts`, `src/main.ts`.

**0.1.1 additions:** `src/detection/filters.ts` (biquad high-pass, pure), `src/detection/noiseFloor.ts` (quiet measurement + floor tracker, pure), tests in `test/filters.test.ts`, `test/noiseFloor.test.ts` (synthetic noise + 30 Hz rumble + 110 Hz burst, helpers in `test/signals.ts`).

**0.2 additions:** `src/detection/fft.ts`, `onset.ts` (streaming detector), `pipeline.ts`, `evaluate.ts`; `src/audio/wav.ts`, `recording.ts`; the worklet runs the detector and records raw chunks; `src/ui/strumView.ts` (flash, counter, log), `devDrawer.ts` + `devSettings.ts` (sliders: δ, λ, min gap, margin above room), `share.ts` (Web Share with files, download fallback); `tools/evaluate.ts`; `test/fixtures/README.md`; tests `test/onset.test.ts`, `wav.test.ts`, `recording.test.ts`. Sliders are not saved between page loads (on purpose: a reload always gives the tested defaults; "Copy settings" captures a tweak).

**0.2.1 additions:** `src/detection/pitch.ts` (MPM pitch detector + streaming `PitchTracker`), `src/detection/tuner.ts` (standard tuning, nearest string, cents, `TunerSmoother`), `lowPassCoeffs` in `filters.ts`, `pitchConfig` + `tunerConfig` in `config.ts`; worklet `tap` control message and `analysis` chunks (`audio/messages.ts`, `capture.worklet.ts`); `src/ui/tunerView.ts`; mode switch "Strum check | Tuner" in `index.html`/`main.ts` (no mic restart). Copy info gains a "Tuner" row (A4 reference + last reading per string, ✓ if recently in tune). Tests `test/pitch.test.ts`, `tuner.test.ts`, `tunerView.test.ts`. `window.__micDebug.tuner` (mode, display, lastPitch, lastReading, frame counts, average ms) and `__micDebug.setMode('tuner')` help scripted checks.

**0.3 additions:** `src/detection/chords.ts` (voicings, templates), `chroma.ts` (peak-folded chroma + bass chroma), `classifier.ts` (`ChordClassifier`: scores, confidence, "?"), `strum.ts` (`StrumTracker`), `chordConfig` in `config.ts`; onset merging (`minInterOnsetMs` 110, `splitStrengthRatio`, `strumLevelSpanDb`, `refineBaselineFraction`) and `flush()` in `onset.ts`; `detectStrumsInAnalysis` in `pipeline.ts`; `scoreChords` in `evaluate.ts` (and chord accuracy in `npm run evaluate` when labels have a `chord`); noise floor: digital-silence skip, re-measure, `unsteadyStart`; UI: big chord name + confidence + score row, chord column in the log, "Save to device" + "Share…" with a "send the original .wav" hint; export `formatVersion` 2. Tests `test/chords.test.ts`, `test/strum.test.ts`, plus additions to the onset, noise floor and recording tests.

**Chords (Plain English, 0.3).** After each strum, the big box shows the chord it heard (**Am, C, G or D**) with how sure it is ("87% sure"), and a small row underneath shows how well each of the four chords matched (higher = better). **"?"** in amber means it is not sure: the strum was too quiet, two chords matched about equally, or none matched well (for example a chord that is not one of the four). The chord appears about a fifth of a second after the strum, because the app has to hear the notes ring first. There is no "teach it my guitar" step yet (that is 0.4), so some strums will show "?".

**Saving recordings (Plain English, 0.3).** After Stop, tap **Save to device**. The `.wav` and `.json` go to your phone's **Downloads** folder. Send them by **attaching the files** (Files → Downloads) rather than sharing the recording into a chat as audio: WhatsApp re-compresses audio, which loses detail (rec1 arrived that way and was 0.5 s shorter). **Share…** is still there if you need it.

**Tuner (Plain English).** Tap **Tuner** at the top. Pluck one string and let it ring: the big letter shows which string the app thinks you're playing (and its number, 6 = thickest), the bar shows how far off it is (centre green zone = in tune, left = too low, right = too high), and the text says **Tune up ↑** (tighten), **Tune down ↓** (loosen) or **In tune ✓**. Each string's chip at the bottom turns green once it has been in tune for a moment, and stays green for 90 seconds, so you can see when all six are done. If the app keeps picking the wrong string (very out-of-tune guitar), tap that string's chip to lock the tuner to it; tap it again to go back to automatic. The microphone keeps running when you switch between Strum check and Tuner.

**Strum detection and recording (Plain English).** The big box flashes green and the counter goes up on every strum the app hears. The log lists each one with its time since Start, how sharp it was ("strength") and how far above the room noise it was. A strum must be clearly louder than the room (10 dB by default) to count, so background noise should not trigger it. "Record" saves up to 2 minutes of the **unprocessed** microphone sound plus the strums found. Since 0.3, **"Save to device"** puts the `.wav` and the results file in Downloads (preferred: attach them from there). **"Share…"** opens the Android share sheet; there the results file may arrive as `.json.txt`, because Chrome won't share `.json` files directly. That's fine. These recordings become the test library every later version must pass.

**Export details (Technical).** WAV: raw path (before the high-pass), mono, 16-bit PCM, at the context sample rate. JSON (`strums-<local time>.json`): `{ format, formatVersion, sampleRate, device, build, recordedAt, durationSec, frames, noiseFloorDb, noiseFloorDbAtEnd, config: { onset, analysis, noiseFloor, chord }, deviceInfo, events: [{ timeSec, strength, levelDb, sampleIndex, chord, chordBest, confidence, scores }] }` (`formatVersion` 2 since 0.3; `chord` is "?" when unsure, `chordBest` is the top score anyway). **Save path (0.3):** "Save to device" = plain downloads (bit-exact files in Downloads), and it is the main button. The UI asks the owner to attach the original .wav from Files/Downloads, because chat apps re-encode shared audio (rec1 came back as AAC via WhatsApp). "Share…" keeps the old share-sheet behaviour. with times relative to the WAV start. Same shape as the draft label format, but the events are *detections*: hand-check them before saving as `*.labels.json`. Events are filtered at export time, so strums confirmed just after Stop are still included. Share order: `[wav, json]` → `[wav, json as .json.txt text/plain]` → `[wav]` + download the JSON → download both.

**Noise floor and high-pass (Plain English).** The mic hears the room all the time (fans, fridge, traffic) because we deliberately switch off the phone's noise suppression, which would also damage the guitar sound. Instead of hiding that noise, the meter now *measures* it. For 2 seconds after Start the screen says "Stay quiet..." and the app learns how loud your room is. After that, everything up to "room level + 6 dB" is drawn grey, and only sound clearly above the room lights up green/amber/red, with a big "Quiet" / "Sound!" label. Very low rumble (below the guitar's lowest string) is filtered out before measuring, so bumps, handling noise and mains hum don't move the meter. The raw recording is not changed by any of this. The measured room level will also be what strum detection (0.2) compares against.

**Noise floor and high-pass (Technical).**
- *Two paths in the worklet.* Raw input is never modified (clip detection now, recording in 0.2). The analysis path is the input through `analysisConfig.highPassStages` x 2nd-order Butterworth HPF at `analysisConfig.highPassHz` (70 Hz; RBJ biquad, TDF-II, state carried across 128-frame quanta). `LevelMessage` carries analysis `sumSquares`/`peak` plus `rawSumSquares`/`rawPeak`; `clipCount` is from the raw signal. Meter, peak hold and noise floor use the analysis path.
- *Filter numbers (1 stage, 48 kHz):* -3 dB at 70 Hz, -1.8 dB at 82 Hz (low E), -0.7 dB at 110 Hz, -4.6 dB at 60 Hz, -6.8 dB at 50 Hz, -14.9 dB at 30 Hz. It weakens rumble, it does not remove it: rumble 17 dB above the noise still adds ~4.5 dB to the measured floor (tested). `highPassStages: 2` gives ~-29 dB at 30 Hz at the cost of ~2 dB more loss at 82 Hz.
- *Initial floor:* `noiseFloorConfig.initialPercentile` (p90) of per-block (1024-frame, ~21 ms) analysis RMS in dBFS over `quietMeasureMs` (2 s). Clamped at `minDb` (**−90** since 0.3, was −100), i.e. below the meter's -60 dB scale, so quiet phones get a real number.
- *0.3 fixes after the Galaxy S24 session (floor "−15.2 at start", then −100):*
  - **Digital silence is ignored.** Blocks below `digitalSilenceDb` (−120 dBFS, i.e. exact zeros) do not count for the measurement or the tracker. The main thread now passes unclamped levels (−Infinity for zeros). The −100 reading could only come from 1 s windows that were mostly exact zeros: the tracker falls toward any quieter window, down to the clamp. The likely source is Android Chrome feeding silence while the page was in the background or the screen was off (the session lasted ~3 minutes, with the tuner and probably a switch to WhatsApp). Not confirmed from the export. Ignored silence is shown in Device info.
  - **Robust start.** A measurement is "unsteady" if p90 − p10 > `maxQuietSpreadDb` (12 dB) or its median > `maxQuietDb` (−30 dBFS; continuous strumming with ringing strings has a small spread but is −10 to −25 dBFS). It is repeated up to `maxQuietRetries` (2) times, and the chip and status say **"Please stay quiet — measuring again"**. If it is still unsteady, the floor = min(p20, `unsteadyMaxFloorDb` −50 dBFS), Device info warns, and the tracker adjusts from there.
- *Tracker:* blocks are grouped into `trackWindowMs` (1 s) windows; the window's p90 moves the floor: down at up to `fallDbPerSec` (10), up at up to `riseDbPerSec` (0.5), and windows above floor + `ignoreAboveDb` (10) are ignored. So a strum during the quiet measurement is corrected within a few seconds, and playing never raises the floor. Trade-off: if the room suddenly gets >10 dB louder (e.g. a TV turns on) the tracker will not follow; the "Measure room again" button restarts the quiet measurement.
- *Display:* "above room" = smoothed level > floor + `roomMarginDb` (6). Readouts "Room noise" (rounded dBFS) and "Above room" (level - floor). If the initial floor > `noisyRoomDb` (-35 dBFS) a "noisy room" hint is shown. Device info / Copy info gain "Analysis high-pass" and "Room noise floor" (now + at start).
- *Headless note:* Chromium's fake mic is a periodic full-scale beep with digital silence in between, so the measured floor varies a lot run to run (-48 to -78 dBFS seen) and the chip mostly reads "Sound!". Only a real phone can judge the Quiet/Sound split.

---

## 6. How you (the owner) will test it on your phone (Plain English)

**What the developer (Claude) handles:** writing the code, running the automated tests, building the page and publishing it to a web link, and analysing the recordings you send back. **You never need to use a terminal or install anything.**

**One-time setup you may need to do:** turning on GitHub Pages can require one click in the repository's settings (**Settings → Pages → Source: "GitHub Actions"**). The developer will tell you exactly when and where to click.

### Before you start
1. **Tune your guitar** to standard tuning (E A D G B E) with any tuner app or clip-on tuner. A capo is not supported in Phase 0.
2. **Pick a quiet room.** No TV, music, fan or people talking.
3. **Remove Bluetooth.** Turn off or disconnect Bluetooth headphones and speakers.
4. **Place the phone** on a table or stand about **50 cm–1 m** (arm's length) in front of the guitar's sound hole, with the bottom edge (where the mic is) facing the guitar. Don't hold it, and don't put it in a pocket or under paper.
5. Set phone volume to medium. Turn on Do Not Disturb so calls and notifications don't interrupt.

### Run it
6. **Open the link** the developer sends you, in **Safari** (iPhone) or **Chrome** (Android).
7. Tap **Start**. When the phone asks to use the microphone, tap **Allow**.
8. Strum once. The **level meter** should jump. If it turns red, move the phone a bit further away.
9. **Calibration, latency:** tap "Latency test". Stay quiet while it plays clicks, then strum along to the clicks or flashes for 16 beats when asked.
10. **Calibration, "teach it my guitar":** strum each chord 5 times when the screen asks (Am, C, G, D). Let each strum ring for about a second.

### Test routine
11. **Single chords:** in Test mode choose "10 × each chord". Strum each chord 10 times, one strum per click, with a full downstroke across all the strings in the shape.
12. **Slow progression:** choose "Progression – slow" (e.g. 60 BPM): Am → C → G → D, one strum per beat, 4 times through.
13. **Medium progression:** same at "medium" (e.g. 90 BPM).
13b. **Strumming pattern:** choose "Pattern": play a down-down-up-up-down-up pattern on each chord, one chord per bar, at slow tempo. This checks that up-strums are counted too.
14. **Silence check:** choose "Silence – 1 minute". Hold the guitar without playing and let strings ring or touch them lightly, as you naturally would. This counts false triggers.
15. After each test the screen shows a **score card**. Take a screenshot or note the numbers.

### Send results back
16. Tap **Save to device**. The `.wav` recording and the results `.json` are saved to your phone's **Downloads**. Send them to the developer by **attaching the original files** from Files → Downloads (as a document/file). Please don't share the recording into a chat as audio: apps like WhatsApp re-compress it and the developer loses detail.
17. Also tell the developer, in plain words: your **phone model**, your **guitar type** (acoustic/electric/nylon), and anything odd you noticed ("it kept saying C when I played Am").

The developer adds your recordings to the test library, tunes the detector, and sends you a new link (often the same link, just refreshed).

---

## 7. Phase 0 milestones

Each milestone ends with a link you can open on your phone.

| # | Milestone | What you'll see | Acceptance criteria |
|---|---|---|---|
| **0.1** | Mic + level meter on the phone | Start button, level meter, device info panel | Works in Android Chrome over HTTPS (on every Android phone the owner has). Meter responds to the guitar. Processing-off settings are reported. Deploy pipeline works (push → live link). Survives lock/unlock with a "tap to resume". |
| **0.2** | Strum (onset) detection | A flash plus a log line on every strum, sensitivity slider | Recall ≥ 95% and < 1 false trigger/min on the first recordings. One event per strum (no doubles). Recording/export of raw audio works early so we can start the golden set. |
| **0.2.1** | Built-in guitar tuner | "Strum check / Tuner" switch; note, string, needle, cents, tune up/down, six string chips | Reads each open string within ±2 cents on synthetic tests, no octave errors; on the owner's guitar it identifies all six strings and the owner can tune with it. Strum detection unchanged. |
| **0.3** | Chroma + chord classification | Big chord name for every strum | ≥ 85% correct on clean single-chord strums without calibration (first pass). Golden tests run in Node. Meyda cross-check agrees. |
| **0.4** | Confidence + calibration | Confidence %, "?" when unsure, latency test, "teach it my guitar" | ≥ 90% correct after per-player calibration. Wrong-but-confident ≤ 3%. Latency calibration gives repeatable values (±5 ms across 3 runs). Timing error median < 15 ms, p95 < 30 ms. |
| **0.5** | Test mode + results export | Metronome-driven tests, score card, export of WAV + labelled JSON | Exports load directly as golden fixtures. The full routine in section 6 runs end-to-end on the owner's phone. All section 4.2 targets measured and reported in a short Phase 0 report. |

**Exit of Phase 0:** a short written result (what passed, per-device latency, recommendation for whether templates are enough or ML is needed, and input to the engine decision).

### 7a. Recording rec1 (Galaxy S24, 2026-10-06) (Technical)

- **Material:** Am, C, G, D × 5 requested. The WAV came through WhatsApp (AAC, lossy) and is kept outside the repo; the full report is in the developer's scratchpad.
- **Alignment:** WAV = JSON + 43 ms (AAC priming); the end is trimmed by ~0.46 s. Found by cross-correlating the 0.3 detector's onsets with the app's events over ±700 ms. Cross-check: the 0.2.1 detector re-detected all 35 app events offline at exactly +43 ms.
- **Strums:** 0.2.1 gave 35 events for 20 strums; 0.3 gives **22** (20/20 found, 2 extras).
- **Chords, no calibration:** C/G/D: **12/15 correct, 3 "?", 0 wrong**, best guess right 15/15, confidence on correct ones 35–89%. The "Am" group is **Em** in the audio (4 "?", 1 G at 30%).
- **Not validated yet:** Am vs C on real audio, up-strums, the Pixel 10.
- **Next recording should have:** a real Am (x02210), down-up patterns, and one take on each phone, saved with "Save to device".

---

## 8. Risks, assumptions and open questions

### 8.1 Assumptions (made for Phase 0 only; not game rules)
- A1. Standard tuning, no capo, open-position shapes as in the table in 2.3.
- A2. **Confirmed:** acoustic steel-string guitar played through the air into the phone's built-in mic. No cable or interface.
- A3. Full strums (not single notes, arpeggios or muted strums). **Updated:** the game will have an easier mode (which chord) and an advanced mode (strums on the beat with strumming patterns), so both down- and up-strums are targeted, and timing accuracy matters.
- A4. Only Am, C, G, D, plus "none/unsure". Nothing else needs recognising yet.
- A5. **Confirmed:** game audio (music, metronome) goes through **headphones** while listening, so the phone speaker stays quiet and the mic hears only the guitar. **Wired (USB-C) headphones are recommended**: Bluetooth headphones add ~100–300 ms of delay. That delay can be partly cancelled by the latency calibration, but it is less steady. In Phase 0 the metronome can also be a visual flash, so headphones are optional there.
- A6. One player, quiet room, phone stationary.

### 8.2 Risks
- **R1. Am/C and G/D confusion.** Mitigated by discriminative and bass weighting, per-player calibration, and "unsure". Fallback: an ML classifier.
- **R2. Android input latency varies widely** (some devices 80+ ms, inconsistent). Mitigated by per-device calibration. May drive the engine decision (native audio via Oboe).
- **R3. Speaker sound bleeding into the mic** (metronome now, game music later) causes false strums and corrupts chroma. Echo cancellation can't be used because it damages guitar sound. This is a **major design risk for the final game** if music plays during play.
- **R4. Browser/OS changes** (iOS Safari audio behaviour changes between versions). Mitigated by the device info panel and testing on current versions.
- **R5. Phone mics are weak on bass**, so bass-note cues may be unreliable. Mitigated by keeping bass as a tiebreaker only.
- **R6. Licences:** Essentia.js (AGPL) and aubio (GPL) must not ship in a closed commercial game without a commercial licence. They are kept to dev-only comparison.
- **R7. Small test set** (one guitar, one player) leads to overfitting. Mitigated by recording with varied strumming, distances and at least two phones. More players and guitars later.
- **R8. iOS interruptions** (calls, Siri, lock screen) stop audio. Must be handled gracefully; matters more in the real game.

### 8.3 Open questions for the game-director (and owner)

**Answered by the owner (2026-10-05):** Q1, both modes: an easier "which chord" mode and an advanced mode with the beat and strumming patterns. Q4, no speaker music while listening; headphones are fine (developer recommends wired). Q10, Android phones and an acoustic guitar. The rest are still open, and none of them block Phase 0.

1. **Timing vs. correctness:** will the game judge *when* you strum (rhythm game, on the beat) or only *which* chord? This sets how hard the latency targets must be.
2. **Tempo and strumming patterns:** expected BPM range? One strum per chord change, or continuous down-up patterns (which affects the minimum gap between strums)?
3. **Chord set growth:** will later levels add chords (Em, E, A, F, barre chords, 7ths)? A larger set makes template matching harder and may push towards ML earlier.
4. **Music during play:** will the game play backing music/sounds from the phone speaker *while* listening? (See R3. This is the biggest technical question for the final game.) Is "headphones required" acceptable?
5. **Wrong or unsure strums:** how should the game treat "unsure" vs. a wrong chord? Can it be forgiving (ignore unsure)?
6. **Guitar types:** acoustic only, or also electric (unplugged/amplified), nylon/classical, ukulele? Alternate tunings or capo?
7. **Player setup:** is a ~1-minute calibration ("teach it my guitar" + latency test) acceptable in the game's first-time flow?
8. **Platforms and engine:** iOS, Android, both, web? Any preference or constraint on the final engine (Unity vs. web/PWA vs. other)? Record the answer in `docs/DECISIONS.md`.
9. **Noise environment:** are players expected to play in noisy places (living room with TV, outdoors)?
10. **Owner's devices:** *answered:* two Android phones, a Google Pixel 10 and a Samsung Galaxy S24 (SM-S9210), and an acoustic guitar.
12. **(new, 0.3) Chords outside the four:** rec1's "Am" strums were really E minor. The app now says "?" for most of these. Should the game recognise "wrong chord" separately from "unsure" (e.g. "that sounded like Em")? That needs more templates and is a design question.
11. **In-game tuner (new, 0.2.1):** the prototype now has a tuner because chord detection assumes an in-tune guitar. Should the final game include a tuner (e.g. as a required/suggested step before playing, or in settings)? Should it support alternate tunings, a capo, or a different A4 reference (e.g. 442 Hz)? Should the game warn when the guitar drifts out of tune?

### 8.4 Proposed decision entry (for `docs/DECISIONS.md`, to be added by the owner/game-director if agreed)
> 2026-10-05 · Phase 0 audio prototype built as a mobile web page (TypeScript + Web Audio AudioWorklet) with a portable, DOM-free detection core and a golden WAV test set. Final game engine still open. · Fastest iteration on real phones; detection method, parameters and recordings carry over to any engine. · developer (proposed)
