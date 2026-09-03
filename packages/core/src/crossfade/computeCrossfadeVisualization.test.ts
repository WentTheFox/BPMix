import { describe, expect, it } from 'vitest';
import { computeCrossfadeVisualization, realTimeForOutgoingPosition } from './computeCrossfadeVisualization';
import { computeTransitionPlan } from './computeTransitionPlan';

describe('computeCrossfadeVisualization', () => {
  it('produces gain curves that fade outgoing 1->0 and incoming 0->1 across the fade phase', () => {
    const plan = computeTransitionPlan(180, 5);

    const viz = computeCrossfadeVisualization(plan, 120, 120);

    expect(viz.outgoing.gainCurve[0]).toBeCloseTo(1, 6);
    expect(viz.outgoing.gainCurve[viz.outgoing.gainCurve.length - 1]).toBeCloseTo(0, 6);
    expect(viz.incoming.gainCurve[0]).toBeCloseTo(0, 6);
    expect(viz.incoming.gainCurve[viz.incoming.gainCurve.length - 1]).toBeCloseTo(1, 6);
  });

  it('never produces an outgoing beat time past fadeDurationSeconds (it has stopped playing by then)', () => {
    const plan = computeTransitionPlan(180, 5);

    const viz = computeCrossfadeVisualization(plan, 174, 174);

    for (const t of viz.outgoing.beatTimesSeconds) {
      expect(t).toBeLessThanOrEqual(viz.fadeDurationSeconds + 1e-6);
    }
  });

  it('spaces beats evenly at the given bpm, on both lanes, with no rate ramp this round', () => {
    const plan = computeTransitionPlan(180, 6);

    const viz = computeCrossfadeVisualization(plan, 120, 100);

    const outgoingPeriod = 60 / 120;
    const outgoingGaps = viz.outgoing.beatTimesSeconds.slice(1).map((t, i) => t - viz.outgoing.beatTimesSeconds[i]!);
    for (const gap of outgoingGaps) expect(gap).toBeCloseTo(outgoingPeriod, 6);

    const incomingPeriod = 60 / 100;
    const incomingGaps = viz.incoming.beatTimesSeconds.slice(1).map((t, i) => t - viz.incoming.beatTimesSeconds[i]!);
    for (const gap of incomingGaps) expect(gap).toBeCloseTo(incomingPeriod, 6);
  });

  it('reports a zero-width ramp window and includes context before the fade and after it', () => {
    const plan = computeTransitionPlan(300, 5);

    const viz = computeCrossfadeVisualization(plan, 90, 130, { contextSecondsBefore: 5, contextSecondsAfter: 5 });

    expect(viz.rampStartSeconds).toBe(0);
    expect(viz.rampEndSeconds).toBe(0);
    expect(viz.timelineStartSeconds).toBeCloseTo(-5, 6);
    expect(viz.timelineEndSeconds).toBeCloseTo(plan.fadeDurationSeconds + 5, 6);
    expect(viz.outgoing.beatTimesSeconds.some((t) => t < 0)).toBe(true);
    expect(viz.incoming.beatTimesSeconds.some((t) => t > plan.fadeDurationSeconds)).toBe(true);
    // Outgoing has already faded out and stopped playing after the transition.
    expect(viz.outgoing.beatTimesSeconds.some((t) => t > plan.fadeDurationSeconds)).toBe(false);
    // Incoming hasn't started yet before the fade begins.
    expect(viz.incoming.beatTimesSeconds.some((t) => t < 0)).toBe(false);
  });

  it('returns no beats (not a crash) when a bpm is unusable', () => {
    const plan = computeTransitionPlan(180, 5);

    expect(() => computeCrossfadeVisualization(plan, 0, 128)).not.toThrow();
    expect(computeCrossfadeVisualization(plan, 0, 128).outgoing.beatTimesSeconds).toEqual([]);
  });
});

describe('realTimeForOutgoingPosition', () => {
  it('is a linear offset from fadeStartSeconds (no ramp this round)', () => {
    const plan = computeTransitionPlan(180, 5);
    expect(realTimeForOutgoingPosition(plan, plan.fadeStartSeconds)).toBe(0);
    expect(realTimeForOutgoingPosition(plan, plan.fadeStartSeconds + 10)).toBe(10);
  });
});
