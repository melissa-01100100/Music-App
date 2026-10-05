# Tech

> Owner: developer. Stack, folder structure, conventions, how to run and test.
> Status: **Phase 0 plan (audio detection prototype)**. No application code has been written yet.
> Last updated: 2026-10-05

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

### 2.3 Chord recognition (Technical)

- **Analysis window:** start ~30 ms after the onset (skipping the pick transient) and run to ~130 ms (configurable `chordWindowStartMs` / `chordWindowEndMs`). Average several overlapping frames in that span.
- **Chroma / pitch class profile (PCP):** FFT with N=4096 (~85 ms) or N=8192 with zero-padding, fold magnitude bins between ~75 Hz and ~2 kHz into 12 pitch classes (A4 = 440 Hz reference, ±50 cents per class, with optional tuning offset estimation). Log-compress, then L2-normalise. A CQT gives better low-frequency resolution but costs more. Start with FFT-chroma and compare against Meyda/Essentia.
- **Templates with harmonic weighting:** for each chord, build a 12-bin template from its notes **including the first few harmonics** (each note's 2nd, 3rd, 4th partials with decaying weights such as 1, 0.6, 0.4, 0.3), because a guitar's E3 also puts energy at B4 and so on. Better still, build templates from the **actual open-position voicings** below, since we know exactly which strings sound.
- **Score:** cosine similarity between the measured chroma and each template.
- **Confidence:** combine the best similarity `s1` with the margin over the second best `s1 − s2`. For example `confidence = clamp((s1 − sMin)/(1 − sMin)) · clamp((s1 − s2)/marginFull)`. Report **"unsure"** if `s1 < minSimilarity` or `s1 − s2 < minMargin`. The exact formula will be fitted on recorded data. Confidence should be *calibrated*: of the strums reported at 80% confidence, about 80% should be correct.

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

**Recommendation:** **hand-roll a small DSP core** (FFT via a permissive library, spectral-flux onsets, FFT-chroma, template matching). Reasons: (1) it is small and fully understood, which makes it easy to tune and to port; (2) no licence risk for a commercial game; (3) no heavy WASM blob to load on phones. Use Meyda (and Essentia.js in a dev-only tool) to **cross-check** our numbers on the golden clips.

**Later option, ML:** if templates plus calibration plateau below target, train a **tiny classifier** (e.g. logistic regression or a small CNN over a few chroma/log-spectrum frames, 5 outputs including "none") on the labelled recordings. It is still small enough to port (ONNX, or hand-written inference). We only do this if the data shows it is needed, and the golden set we are building now is exactly the training data it would need.

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

- **The owner's own phone(s)** first (model to be confirmed, see open questions).
- **Android phones in Chrome** (owner answer, 2026-10-05). If the owner has more than one Android phone, test on each, because Android mic delay varies a lot between models.
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
      fft.ts                   # wraps a permissive FFT library
      onset.ts                 # spectral flux / HFC, adaptive threshold, peak picking
      chroma.ts                # chroma + bass chroma
      chords.ts                # chord templates (voicings, harmonic weights)
      classifier.ts            # cosine match, confidence, "unsure"
      detector.ts              # streaming API: push(samples) -> events
      types.ts                 # ChordEvent { chord, timeSec, sampleIndex, confidence, scores }
    audio/                     # browser-only glue
      mic.ts                   # getUserMedia, AudioContext resume, settings report
      capture.worklet.ts       # AudioWorklet processor (frame counting, ring buffer)
      recorder.ts / wav.ts     # record + encode WAV
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
16. Tap **Export**. Your phone's share sheet opens. Save the files (one `.wav` recording and one results `.json`), then send them to the developer the same way you share files in our chat (or upload them to a shared folder if we set one up).
17. Also tell the developer, in plain words: your **phone model**, your **guitar type** (acoustic/electric/nylon), and anything odd you noticed ("it kept saying C when I played Am").

The developer adds your recordings to the test library, tunes the detector, and sends you a new link (often the same link, just refreshed).

---

## 7. Phase 0 milestones

Each milestone ends with a link you can open on your phone.

| # | Milestone | What you'll see | Acceptance criteria |
|---|---|---|---|
| **0.1** | Mic + level meter on the phone | Start button, level meter, device info panel | Works in Android Chrome over HTTPS (on every Android phone the owner has). Meter responds to the guitar. Processing-off settings are reported. Deploy pipeline works (push → live link). Survives lock/unlock with a "tap to resume". |
| **0.2** | Strum (onset) detection | A flash plus a log line on every strum, sensitivity slider | Recall ≥ 95% and < 1 false trigger/min on the first recordings. One event per strum (no doubles). Recording/export of raw audio works early so we can start the golden set. |
| **0.3** | Chroma + chord classification | Big chord name for every strum | ≥ 85% correct on clean single-chord strums without calibration (first pass). Golden tests run in Node. Meyda cross-check agrees. |
| **0.4** | Confidence + calibration | Confidence %, "?" when unsure, latency test, "teach it my guitar" | ≥ 90% correct after per-player calibration. Wrong-but-confident ≤ 3%. Latency calibration gives repeatable values (±5 ms across 3 runs). Timing error median < 15 ms, p95 < 30 ms. |
| **0.5** | Test mode + results export | Metronome-driven tests, score card, export of WAV + labelled JSON | Exports load directly as golden fixtures. The full routine in section 6 runs end-to-end on the owner's phone. All section 4.2 targets measured and reported in a short Phase 0 report. |

**Exit of Phase 0:** a short written result (what passed, per-device latency, recommendation for whether templates are enough or ML is needed, and input to the engine decision).

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
10. **Owner's devices:** which phone(s) does the owner have for testing, and which guitar?

### 8.4 Proposed decision entry (for `docs/DECISIONS.md`, to be added by the owner/game-director if agreed)
> 2026-10-05 · Phase 0 audio prototype built as a mobile web page (TypeScript + Web Audio AudioWorklet) with a portable, DOM-free detection core and a golden WAV test set. Final game engine still open. · Fastest iteration on real phones; detection method, parameters and recordings carry over to any engine. · developer (proposed)
