# Decision Log

| Date | Decision | Why | Who |
|---|---|---|---|
| 2026-10-05 | Phase 0 prototype is a mobile web page (TypeScript + AudioWorklet) with a portable detection core and recorded test clips; final engine still open | Fastest testing on real phones; method, settings and recordings carry over to any engine | developer (pending owner approval) |
| 2026-10-05 | Game has an easier mode (which chord) and an advanced mode (on the beat, with strumming patterns) | Owner answer | owner |
| 2026-10-05 | Game audio is played through headphones while listening (wired recommended); no speaker music during play | Speaker sound leaks into the mic and causes false strums | owner + developer |
| 2026-10-05 | Phase 0 targets Android phones (Chrome) and an acoustic guitar | Owner's devices | owner |
| 2026-10-05 | Repository made public so the prototype can be hosted free on GitHub Pages | Private repos need a paid plan for Pages; owner chose public over Netlify or GitHub Pro | owner |
| 2026-10-05 | Strum detection runs inside the capture AudioWorklet; the FFT is our own small radix-2 code (no library) | Measured ~0.7% of the audio thread; sample-exact timing; immune to UI stalls; no licence risk | developer |
| 2026-10-06 | Test phones are the owner's Google Pixel 10 and Samsung Galaxy S24 (SM-S9210); results are labelled per device | Owner correction: 0.1 was on the Pixel 10, rec1 and the 0.2/0.2.1 test on the Galaxy S24 | owner |
| 2026-10-06 | Chord classification runs on the main thread, on ~160 ms of audio the worklet sends with each strum; the worklet only does onsets | An 8192-point FFT per strum (~1 ms) is risky inside one 2.7 ms audio quantum; ~1.3 ms on the main thread, and timing still comes from the audio clock | developer |
| 2026-10-06 | Strums within 110 ms of the first peak are merged into one; exports are saved to device by default | rec1: slow strums double-triggered at 70 ms; WhatsApp re-encoded the shared WAV | developer |
