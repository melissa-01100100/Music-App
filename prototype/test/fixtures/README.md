# Golden test clips

Put recordings here as pairs:

- `name.wav` (mono or stereo, 16/24/32-bit PCM or 32-bit float; the first channel is used)
- `name.labels.json` with hand-checked strum times:
  `{ "sampleRate": 48000, "device": "Pixel 10 ...", "events": [ { "timeSec": 1.234, "chord": "C" } ] }`

The app's "Share / save files" export (`strums-<date>.wav` + `.json`) has the same shape. Its
events are what the app *detected*, so check and correct them before renaming the `.json` to
`.labels.json`. If the labels file has `noiseFloorDb`, that room level is used for the level gate;
otherwise it is estimated from the clip.

Run `npm run evaluate` (from `prototype/`) to score the detector on every pair.
