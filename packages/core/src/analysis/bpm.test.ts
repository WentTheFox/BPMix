import { describe, expect, it } from 'vitest';
import { estimateBpm } from './bpm';

const SAMPLE_RATE = 44100;

/**
 * A click train: a short burst of tone every `periodSeconds`, starting at
 * `firstBeatSeconds` - a clean synthetic stand-in for a track with a steady
 * beat, so the estimator's recovered bpm/phase can be checked against a
 * known-correct answer.
 */
function clickTrain(options: {
  durationSeconds: number;
  bpm: number;
  firstBeatSeconds: number;
  clickSeconds?: number;
  amplitude?: number;
}): Float32Array {
  const { durationSeconds, bpm, firstBeatSeconds, clickSeconds = 0.05, amplitude = 0.8 } = options;
  const periodSeconds = 60 / bpm;
  const length = Math.round(durationSeconds * SAMPLE_RATE);
  const out = new Float32Array(length);

  for (let beatTime = firstBeatSeconds; beatTime < durationSeconds; beatTime += periodSeconds) {
    const start = Math.round(beatTime * SAMPLE_RATE);
    const end = Math.min(length, start + Math.round(clickSeconds * SAMPLE_RATE));
    for (let i = start; i < end; i++) {
      // A short tone burst, not a hard impulse, so it survives the energy envelope's windowing.
      out[i] = amplitude * Math.sin((2 * Math.PI * 1000 * (i - start)) / SAMPLE_RATE);
    }
  }
  return out;
}

describe('estimateBpm', () => {
  it('recovers the tempo of a steady click train', () => {
    const samples = clickTrain({ durationSeconds: 20, bpm: 120, firstBeatSeconds: 0 });

    const { bpm, confidence } = estimateBpm(samples, SAMPLE_RATE);

    expect(bpm).toBeGreaterThan(115);
    expect(bpm).toBeLessThan(125);
    expect(confidence).toBeGreaterThan(0.3);
  });

  it('recovers the beat phase, not just the tempo', () => {
    const samples = clickTrain({ durationSeconds: 20, bpm: 120, firstBeatSeconds: 0.2 });

    const { firstBeatOffsetSeconds } = estimateBpm(samples, SAMPLE_RATE);

    // The phase search only resolves to one envelope hop (~12ms) and only
    // finds *a* beat consistent with the period, not necessarily the very
    // first one - it should land within one beat period of 0.2s.
    const periodSeconds = 60 / 120;
    const nearestEquivalentOffset =
      Math.round((firstBeatOffsetSeconds - 0.2) / periodSeconds) * periodSeconds + 0.2;
    expect(Math.abs(firstBeatOffsetSeconds - nearestEquivalentOffset)).toBeLessThan(0.05);
  });

  it('finds a different tempo correctly (not hardcoded to 120)', () => {
    const samples = clickTrain({ durationSeconds: 20, bpm: 90, firstBeatSeconds: 0 });

    const { bpm } = estimateBpm(samples, SAMPLE_RATE);

    expect(bpm).toBeGreaterThan(85);
    expect(bpm).toBeLessThan(95);
  });

  it('has low confidence for silence (nothing periodic to find)', () => {
    const samples = new Float32Array(Math.round(20 * SAMPLE_RATE));

    const { confidence } = estimateBpm(samples, SAMPLE_RATE);

    expect(confidence).toBe(0);
  });

  it('does not throw on a too-short window', () => {
    const samples = new Float32Array(100);

    expect(() => estimateBpm(samples, SAMPLE_RATE)).not.toThrow();
  });
});
