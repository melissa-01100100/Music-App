# Task Board

> Owner: game-director. Tags: [DEV] [DESIGN] [MARKETING]. Mark done with [x].

## Now
- [ ] [DESIGN] Fill in docs/GAME_DESIGN.md (game-director)
- [x] [DEV] Choose tech stack and write docs/TECH.md (developer). Phase 0 plan approved by owner
- [ ] [DEV] Phase 0 / 0.1: Mic + level meter on the phone (TECH.md section 7). **Built; tested by owner on the Pixel 10 (processing off, 48 kHz, no dropouts). Owner's second test phone: Samsung Galaxy S24 (SM-S9210). Lock/unlock resume not yet reported**
- [x] [DEV] Phase 0 / 0.1.1: Room noise floor ("Stay quiet" measurement + slow tracker), 70 Hz analysis high-pass, grey room zone + Quiet/Sound chip on the meter. **Built 2026-10-05. Used on the Galaxy S24: start floor wrong (strumming during the measurement) and floor collapsed to −100 dBFS; both fixed in 0.3**
- [x] [DEV] Phase 0 / 0.2: Strum (onset) detection, flash + counter + log per strum, Developer drawer (sensitivity δ/λ, minimum gap, margin above room), raw-audio recording + WAV/JSON export (share sheet / download), `npm run evaluate`. **Built 2026-10-05. Owner-tested on the Samsung Galaxy S24 (works); first recording rec1 showed double triggers, fixed in 0.3**
- [x] [DEV] Phase 0 / 0.2.1: Built-in guitar tuner ("Strum check | Tuner" switch, MPM pitch detector, standard tuning, needle + cents + tune up/down, six string chips, tap to lock a string). **Built 2026-10-06. Owner-tested on the Samsung Galaxy S24 (works)**
- [x] [DEV] Phase 0 / 0.3: Chroma + chord classification (Am, C, G, D): big chord name + confidence + per-chord scores, chord in log and export; plus rec1 fixes (double triggers → strum merging, noise floor ignores digital silence and re-measures if played during, "Save to device" + "send the original .wav" hint). **Built 2026-10-06, awaiting owner test on the Galaxy S24 and Pixel 10.** rec1: 22 events for 20 strums (was 35); C/G/D 12/15 correct + 3 "?", 0 wrong. Meyda cross-check not done yet (moved to 0.4). Am not yet tested on real audio (rec1's "Am" was really Em)
- [ ] [DEV] Owner recording rec2 on BOTH phones (Pixel 10 and Galaxy S24): Am, C, G, D × 5 (check the Am shape x02210), then a down-up pattern; save with "Save to device" and attach the original files
- [ ] [DESIGN] Should the game tell "wrong chord" (e.g. "that was Em") apart from "unsure"? See TECH.md 8.3 Q12 (game-director)
- [ ] [DESIGN] Decide whether the final game has a built-in tuner (and alternate tunings / capo / A4 reference). See TECH.md 8.3 Q11 (game-director)
- [ ] [MARKETING] Draft name, tagline and docs/BRAND.md (marketing-design)

## Next
- [ ] [DEV] Phase 0 / 0.4: Confidence calibration + "unsure", latency calibration, "teach it my guitar" calibration, Meyda chroma cross-check
- [ ] [DESIGN] Chord display in the 0.3 prototype (big chord name, "?" in amber, score row) is developer styling only; marketing-design may want to restyle it (marketing-design)
- [ ] [DEV] Phase 0 / 0.5: Test mode + score card + WAV/JSON export that loads as golden fixtures; Phase 0 report

## Later
