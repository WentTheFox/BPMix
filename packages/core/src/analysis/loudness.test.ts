import { describe, expect, it } from 'vitest';
import { computeNormalizationGain, measureLoudnessDb } from './loudness';

function constantAmplitude(value: number, length = 10000): Float32Array {
  return new Float32Array(length).fill(value);
}

describe('measureLoudnessDb', () => {
  it('measures full-scale amplitude as 0 dBFS', () => {
    expect(measureLoudnessDb(constantAmplitude(1))).toBeCloseTo(0, 1);
  });

  it('measures half amplitude as roughly -6dB', () => {
    expect(measureLoudnessDb(constantAmplitude(0.5))).toBeCloseTo(-6, 0);
  });

  it('floors silence instead of returning -Infinity', () => {
    expect(measureLoudnessDb(constantAmplitude(0))).toBeLessThan(-60);
    expect(Number.isFinite(measureLoudnessDb(constantAmplitude(0)))).toBe(true);
  });

  it('returns the silence floor for an empty signal', () => {
    expect(Number.isFinite(measureLoudnessDb(new Float32Array(0)))).toBe(true);
  });
});

describe('computeNormalizationGain', () => {
  it('boosts a quieter-than-target track (gain > 1)', () => {
    expect(computeNormalizationGain(-30)).toBeGreaterThan(1);
  });

  it('attenuates a louder-than-target track (gain < 1)', () => {
    expect(computeNormalizationGain(-6)).toBeLessThan(1);
  });

  it('leaves an at-target track roughly unchanged', () => {
    expect(computeNormalizationGain(-18)).toBeCloseTo(1, 1);
  });

  it('clamps extreme boosts instead of blowing up a near-silent track', () => {
    const gain = computeNormalizationGain(-80);
    expect(gain).toBeLessThanOrEqual(4);
  });

  it('clamps extreme attenuation', () => {
    const gain = computeNormalizationGain(0);
    expect(gain).toBeGreaterThanOrEqual(0.25);
  });
});
