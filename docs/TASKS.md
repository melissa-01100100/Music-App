# Task Board

> Owner: game-director. Tags: [DEV] [DESIGN] [MARKETING]. Mark done with [x].

## Now
- [ ] [DESIGN] Fill in docs/GAME_DESIGN.md (game-director)
- [x] [DEV] Choose tech stack and write docs/TECH.md (developer). Phase 0 plan approved by owner
- [ ] [DEV] Phase 0 / 0.1: Mic + level meter on the phone (TECH.md section 7). **Built; tested by owner on Pixel 10 (processing off, 48 kHz, no dropouts). Lock/unlock resume not yet reported**
- [x] [DEV] Phase 0 / 0.1.1: Room noise floor ("Stay quiet" measurement + slow tracker), 70 Hz analysis high-pass, grey room zone + Quiet/Sound chip on the meter. **Built 2026-10-05, awaiting owner retest on Pixel 10**
- [x] [DEV] Phase 0 / 0.2: Strum (onset) detection, flash + counter + log per strum, Developer drawer (sensitivity δ/λ, minimum gap, margin above room), raw-audio recording + WAV/JSON export (share sheet / download), `npm run evaluate`. **Built 2026-10-05, awaiting owner test on Pixel 10 with the guitar + first recordings**
- [x] [DEV] Phase 0 / 0.2.1: Built-in guitar tuner ("Strum check | Tuner" switch, MPM pitch detector, standard tuning, needle + cents + tune up/down, six string chips, tap to lock a string). **Built 2026-10-06, awaiting owner test on Pixel 10 with the guitar**
- [ ] [DESIGN] Decide whether the final game has a built-in tuner (and alternate tunings / capo / A4 reference). See TECH.md 8.3 Q11 (game-director)
- [ ] [MARKETING] Draft name, tagline and docs/BRAND.md (marketing-design)

## Next
- [ ] [DEV] Phase 0 / 0.3: Chroma + chord classification (Am, C, G, D), golden tests in Node, Meyda cross-check
- [ ] [DEV] Phase 0 / 0.4: Confidence + "unsure", latency calibration, "teach it my guitar" calibration
- [ ] [DEV] Phase 0 / 0.5: Test mode + score card + WAV/JSON export that loads as golden fixtures; Phase 0 report

## Later
