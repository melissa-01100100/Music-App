import { describe, expect, it } from 'vitest';
import { analysisConfig, noiseFloorConfig, type NoiseFloorConfig } from '../src/detection/config';
import { Biquad, highPassCoeffs } from '../src/detection/filters';
import {
  aboveRoomDb,
  isAboveRoom,
  isNoisyRoom,
  NoiseFloorEstimator,
  percentile,
  roomZoneTopDb,
  stepFloor,
} from '../src/detection/noiseFloor';
import { add, noise, rmsOf, sine, SR } from './signals';

const cfg: NoiseFloorConfig = noiseFloorConfig;
const BLOCK = 1024;
const BLOCK_MS = (BLOCK / SR) * 1000;
const toDb = (a: number) => (a > 0 ? 20 * Math.log10(a) : -Infinity);

/** Feeds `x` through HPF + estimator block by block, like the worklet + main thread do. */
function run(est: NoiseFloorEstimator, x: Float32Array, hpf = new Biquad(highPassCoeffs(analysisConfig.highPassHz, SR))) {
  const floors: (number | null)[] = [];
  const y = new Float32Array(BLOCK);
  for (let i = 0; i + BLOCK <= x.length; i += BLOCK) {
    hpf.process(x.subarray(i, i + BLOCK), y);
    est.addBlock(toDb(rmsOf(y)), BLOCK_MS);
    floors.push(est.floorDb);
  }
  return floors;
}

describe('percentile', () => {
  it('interpolates and handles edges', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 90)).toBeCloseTo(4.6);
    expect(percentile([5, 1], 0)).toBe(1);
    expect(percentile([5, 1], 100)).toBe(5);
    expect(percentile([], 90)).toBeNaN();
  });
});

describe('stepFloor', () => {
  it('falls fast, rises slowly, ignores loud windows', () => {
    expect(stepFloor(-50, -60, 1, cfg)).toBe(-60); // within fall speed: jumps to it
    expect(stepFloor(-30, -60, 1, cfg)).toBe(-30 - cfg.fallDbPerSec);
    expect(stepFloor(-60, -55, 1, cfg)).toBeCloseTo(-60 + cfg.riseDbPerSec);
    expect(stepFloor(-60, -60 + cfg.ignoreAboveDb + 1, 1, cfg)).toBe(-60);
    expect(stepFloor(-60, NaN, 1, cfg)).toBe(-60);
  });
});

describe('NoiseFloorEstimator', () => {
  it('measures for quietMeasureMs, then reports the p90 block level', () => {
    const est = new NoiseFloorEstimator(cfg);
    expect(est.state).toBe('measuring');
    expect(est.floorDb).toBeNull();
    const levels: number[] = [];
    let i = 0;
    while (est.state === 'measuring') {
      const db = -60 + (i++ % 10); // -60..-51
      levels.push(db);
      est.addBlock(db, BLOCK_MS);
      if (est.state === 'measuring') expect(est.remainingMs).toBeGreaterThan(0);
    }
    expect(levels.length * BLOCK_MS).toBeGreaterThanOrEqual(cfg.quietMeasureMs);
    expect(est.initialFloorDb).toBeCloseTo(percentile(levels, 90));
    expect(est.floorDb).toBe(est.initialFloorDb);
    expect(est.remainingMs).toBe(0);
  });

  it('restart() starts a fresh measurement', () => {
    const est = new NoiseFloorEstimator(cfg);
    for (let i = 0; i < 200; i++) est.addBlock(-50, BLOCK_MS);
    est.restart();
    expect(est.state).toBe('measuring');
    expect(est.floorDb).toBeNull();
    expect(est.remainingMs).toBe(cfg.quietMeasureMs);
  });

  it('clamps silence (-Infinity) to minDb', () => {
    const est = new NoiseFloorEstimator(cfg);
    for (let i = 0; i < 200; i++) est.addBlock(-Infinity, BLOCK_MS);
    expect(est.floorDb).toBe(cfg.minDb);
  });

  it('falls quickly when the first measurement was too loud (someone strummed during it)', () => {
    const est = new NoiseFloorEstimator(cfg);
    for (let i = 0; i < 100; i++) est.addBlock(-20, BLOCK_MS);
    expect(est.floorDb).toBeCloseTo(-20);
    for (let i = 0; i < Math.ceil(5000 / BLOCK_MS); i++) est.addBlock(-60, BLOCK_MS);
    expect(est.floorDb).toBeCloseTo(-60);
  });

  it('rises only slowly when the room gets a bit louder', () => {
    const est = new NoiseFloorEstimator(cfg);
    for (let i = 0; i < 100; i++) est.addBlock(-60, BLOCK_MS);
    for (let i = 0; i < Math.ceil(4000 / BLOCK_MS); i++) est.addBlock(-55, BLOCK_MS);
    const f = est.floorDb as number;
    expect(f).toBeGreaterThan(-60);
    expect(f).toBeLessThanOrEqual(-60 + cfg.riseDbPerSec * 4 + 0.6);
  });
});

describe('synthetic room: low noise + 30 Hz rumble + 110 Hz burst', () => {
  const quiet = noise(0.001, 3 * SR, 11); // about -60 dBFS
  // Rumble ~17 dB above the noise (about -43 dBFS RMS). A 2nd-order HPF at 70 Hz cuts
  // 30 Hz by ~15 dB, so it ends up at about the noise level instead of dominating it.
  const rumble = sine(0.01, 3 * SR, 30);
  // 0.3 s loud 110 Hz burst (A2) at about -17 dBFS, in the middle of second 2-3.
  const burstSig = new Float32Array(3 * SR);
  const b0 = Math.floor(2.3 * SR);
  burstSig.set(sine(0.2, Math.floor(0.3 * SR), 110), b0);

  it('the HPF keeps the rumble out of the measured floor', () => {
    const withHpf = new NoiseFloorEstimator(cfg);
    run(withHpf, add(quiet, rumble).subarray(0, 2.2 * SR));
    const quietOnly = new NoiseFloorEstimator(cfg);
    run(quietOnly, quiet.subarray(0, 2.2 * SR));
    const noHpf = new NoiseFloorEstimator(cfg);
    const passThrough = { process: (x: ArrayLike<number>, y: Float32Array) => y.set(x as Float32Array) } as unknown as Biquad;
    run(noHpf, add(quiet, rumble).subarray(0, 2.2 * SR), passThrough);
    const quietDb = quietOnly.floorDb as number;
    // Unfiltered, the rumble would set the floor ~15+ dB too high. Filtered, it adds only a few
    // dB (measured ~4.5 dB: a 2nd-order filter does not remove 30 Hz completely), i.e. the
    // HPF takes >= 10 dB of the rumble's effect away.
    const unfilteredRise = (noHpf.floorDb as number) - quietDb;
    const filteredRise = (withHpf.floorDb as number) - quietDb;
    expect(unfilteredRise).toBeGreaterThan(14);
    expect(filteredRise).toBeLessThan(cfg.roomMarginDb);
    expect(unfilteredRise - filteredRise).toBeGreaterThan(10);
    expect(withHpf.floorDb as number).toBeLessThan(-55);
  });

  it('a short loud burst does not raise the floor, and is clearly above the room', () => {
    const est = new NoiseFloorEstimator(cfg);
    const sig = add(quiet, rumble, burstSig);
    const floors = run(est, sig);
    const initial = est.initialFloorDb as number;
    const settled = floors.filter((f): f is number => f !== null);
    expect(Math.max(...settled)).toBeLessThanOrEqual(initial + 0.5);

    // The burst itself reads far above the floor.
    const hpf = new Biquad(highPassCoeffs(analysisConfig.highPassHz, SR));
    const y = new Float32Array(sig.length);
    hpf.process(sig, y);
    const burstDb = toDb(rmsOf(y, b0 + 2048, b0 + 2048 + BLOCK));
    expect(isAboveRoom(burstDb, est.floorDb, cfg.roomMarginDb)).toBe(true);
    expect(aboveRoomDb(burstDb, est.floorDb as number)).toBeGreaterThan(30);
  });

  it('without the HPF, the rumble alone would light the meter as "sound"', () => {
    const rumbleOnlyDb = toDb(rmsOf(add(quiet, rumble)));
    const quietFloorDb = toDb(rmsOf(quiet));
    expect(isAboveRoom(rumbleOnlyDb, quietFloorDb, cfg.roomMarginDb)).toBe(true);
  });
});

describe('room helpers', () => {
  it('zone top, above-room and noisy room', () => {
    expect(roomZoneTopDb(-55, 6)).toBe(-49);
    expect(isAboveRoom(-48, -55, 6)).toBe(true);
    expect(isAboveRoom(-50, -55, 6)).toBe(false);
    expect(isAboveRoom(-10, null, 6)).toBe(false);
    expect(aboveRoomDb(-60, -55)).toBe(0);
    expect(isNoisyRoom(-30, cfg.noisyRoomDb)).toBe(true);
    expect(isNoisyRoom(-50, cfg.noisyRoomDb)).toBe(false);
    expect(isNoisyRoom(null, cfg.noisyRoomDb)).toBe(false);
  });
});
