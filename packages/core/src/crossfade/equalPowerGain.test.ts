import { describe, expect, it } from 'vitest';
import { equalPowerGain } from './equalPowerGain';

describe('equalPowerGain', () => {
  it('always starts outgoing at 1 and incoming at 0, regardless of duration', () => {
    for (const durationSeconds of [0.5, 1, 8, 20]) {
      expect(equalPowerGain(0, true, durationSeconds)).toBeCloseTo(1, 9);
      expect(equalPowerGain(0, false, durationSeconds)).toBeCloseTo(0, 9);
    }
  });

  it('always ends outgoing at 0 and incoming at 1, regardless of duration', () => {
    for (const durationSeconds of [0.5, 1, 8, 20]) {
      expect(equalPowerGain(1, true, durationSeconds)).toBeCloseTo(0, 9);
      expect(equalPowerGain(1, false, durationSeconds)).toBeCloseTo(1, 9);
    }
  });

  it('keeps outgoing^2 + incoming^2 constant (equal power) at any duration', () => {
    for (const durationSeconds of [0.5, 1, 8, 20]) {
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const outgoing = equalPowerGain(fraction, true, durationSeconds);
        const incoming = equalPowerGain(fraction, false, durationSeconds);
        expect(outgoing * outgoing + incoming * incoming).toBeCloseTo(1, 9);
      }
    }
  });

  it('front-loads more of a short fade\'s drop earlier than a long one, so less is left to drop right at the very end', () => {
    const nearEndFraction = 0.9;
    const shortOutgoing = equalPowerGain(nearEndFraction, true, 1);
    const longOutgoing = equalPowerGain(nearEndFraction, true, 8);

    // A short fade eases more (its easedFraction runs further ahead of the
    // raw fraction), so by the same fraction near the end it has already
    // dropped further (lower outgoing gain) than a long fade's
    // near-original shape - leaving a gentler, smaller final approach to 0
    // right at fraction=1, rather than a steep last-moment drop.
    expect(shortOutgoing).toBeLessThan(longOutgoing);
  });

  it('has (near-)zero slope at both ends for a very short fade - the specific abrupt-cutoff regression this eases away', () => {
    const durationSeconds = 0.5; // well under EASE_REFERENCE_SECONDS
    const eps = 1e-4;
    const nearStartSlope = (equalPowerGain(eps, true, durationSeconds) - equalPowerGain(0, true, durationSeconds)) / eps;
    const nearEndSlope = (equalPowerGain(1, true, durationSeconds) - equalPowerGain(1 - eps, true, durationSeconds)) / eps;
    expect(Math.abs(nearStartSlope)).toBeLessThan(0.1);
    expect(Math.abs(nearEndSlope)).toBeLessThan(0.1);
  });
});
