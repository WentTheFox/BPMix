import { describe, expect, it } from 'vitest';
import { computeTransitionPlan } from './computeTransitionPlan';

describe('computeTransitionPlan', () => {
  it('starts the fade fadeDurationSeconds before the track ends', () => {
    const plan = computeTransitionPlan(180, 7);

    expect(plan.fadeDurationSeconds).toBe(7);
    expect(plan.fadeStartSeconds).toBe(173);
  });

  it('starts the incoming track from its very beginning', () => {
    const plan = computeTransitionPlan(180, 5);
    expect(plan.incomingStartSeconds).toBe(0);
  });

  it('clamps a negative or zero crossfade duration to 0 rather than throwing', () => {
    expect(() => computeTransitionPlan(180, -3)).not.toThrow();
    expect(computeTransitionPlan(180, -3).fadeDurationSeconds).toBe(0);
  });

  it('never starts the fade before 0, even when the crossfade duration is longer than the whole track', () => {
    const plan = computeTransitionPlan(3, 10);
    expect(plan.fadeStartSeconds).toBe(0);
  });
});
