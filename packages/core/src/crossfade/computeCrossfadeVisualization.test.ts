import { describe, expect, it } from 'vitest';
import { computeCrossfadeVisualization } from './computeCrossfadeVisualization';
import { computeTransitionPlan } from './computeTransitionPlan';

describe('computeCrossfadeVisualization', () => {
  it('phase-locks both tracks on a beat at t=0 (the fade start), even when the outgoing track had to ramp to get there', () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 150 }, durationSeconds: 300 };
    const incoming = { startWindow: { bpm: 128, bpmConfidence: 0.9, beatAnchorSeconds: 3 } };
    const plan = computeTransitionPlan(outgoing, incoming, 8);
    expect(plan.rampDurationSeconds).toBeGreaterThan(0); // sanity: this scenario does require a ramp

    const viz = computeCrossfadeVisualization(plan, outgoing.endWindow.bpm, incoming.startWindow.bpm);

    expect(viz.outgoing.beatTimesSeconds.some((t) => Math.abs(t) < 1e-6)).toBe(true);
    expect(viz.incoming.beatTimesSeconds[0]).toBeCloseTo(0, 6);
  });

  it("spaces the incoming track's beats evenly at its own (constant, possibly sped-up) rate", () => {
    // Incoming is the slower track here, so it's the one that gets sped up (incomingRate > 1) - never the outgoing one slowed down.
    const outgoing = { endWindow: { bpm: 128, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 100, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };
    const plan = computeTransitionPlan(outgoing, incoming, 6);
    expect(plan.incomingRate).toBeGreaterThan(1); // sanity

    const viz = computeCrossfadeVisualization(plan, outgoing.endWindow.bpm, incoming.startWindow.bpm);

    const realPeriod = 60 / incoming.startWindow.bpm / plan.incomingRate;
    const gaps = viz.incoming.beatTimesSeconds.slice(1).map((t, i) => t - viz.incoming.beatTimesSeconds[i]!);
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(realPeriod, 6);
    }
  });

  it("converges the outgoing track's beat spacing toward the incoming period during the ramp phase (before t=0)", () => {
    // Outgoing much slower than incoming - its beats must visibly compress as the ramp progresses.
    const outgoing = { endWindow: { bpm: 90, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 300 };
    const incoming = { startWindow: { bpm: 130, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };
    const plan = computeTransitionPlan(outgoing, incoming, 8);

    const viz = computeCrossfadeVisualization(plan, outgoing.endWindow.bpm, incoming.startWindow.bpm);
    // Restrict to beats within the ramp phase itself.
    const beats = viz.outgoing.beatTimesSeconds.filter((t) => t >= viz.rampStartSeconds - 1e-6 && t <= viz.rampEndSeconds + 1e-6);
    expect(beats.length).toBeGreaterThan(2);

    const firstGap = beats[1]! - beats[0]!;
    const lastGap = beats[beats.length - 1]! - beats[beats.length - 2]!;
    const incomingPeriod = 60 / 130;
    const outgoingPeriod = 60 / 90;

    // First gap should still be close to the original (slower) period, last
    // gap close to the incoming (faster) period - not the same value.
    expect(firstGap).toBeCloseTo(outgoingPeriod, 1);
    expect(lastGap).toBeLessThan(firstGap);
    expect(Math.abs(lastGap - incomingPeriod)).toBeLessThan(Math.abs(firstGap - incomingPeriod));
  });

  it('produces gain curves that fade outgoing 1->0 and incoming 0->1 across the fade phase', () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };
    const plan = computeTransitionPlan(outgoing, incoming, 5);

    const viz = computeCrossfadeVisualization(plan, 120, 120);

    expect(viz.outgoing.gainCurve[0]).toBeCloseTo(1, 6);
    expect(viz.outgoing.gainCurve[viz.outgoing.gainCurve.length - 1]).toBeCloseTo(0, 6);
    expect(viz.incoming.gainCurve[0]).toBeCloseTo(0, 6);
    expect(viz.incoming.gainCurve[viz.incoming.gainCurve.length - 1]).toBeCloseTo(1, 6);
  });

  it('never produces an outgoing beat time past fadeDurationSeconds (it has stopped playing by then)', () => {
    const outgoing = { endWindow: { bpm: 174, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 174, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };
    const plan = computeTransitionPlan(outgoing, incoming, 5);

    const viz = computeCrossfadeVisualization(plan, 174, 174);

    for (const t of viz.outgoing.beatTimesSeconds) {
      expect(t).toBeLessThanOrEqual(viz.fadeDurationSeconds + 1e-6);
    }
  });

  it('reports the ramp phase window and includes context beats before it (outgoing) and after the fade (incoming)', () => {
    const outgoing = { endWindow: { bpm: 90, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 300 };
    const incoming = { startWindow: { bpm: 130, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };
    const plan = computeTransitionPlan(outgoing, incoming, 5);

    const viz = computeCrossfadeVisualization(plan, outgoing.endWindow.bpm, incoming.startWindow.bpm, {
      contextSecondsBefore: 5,
      contextSecondsAfter: 5,
    });

    expect(viz.rampStartSeconds).toBeCloseTo(-(plan.rampDurationSeconds + plan.beatWaitSeconds), 6);
    expect(viz.rampEndSeconds).toBeCloseTo(-plan.beatWaitSeconds, 6);
    expect(viz.timelineStartSeconds).toBeCloseTo(viz.rampStartSeconds - 5, 6);
    expect(viz.timelineEndSeconds).toBeCloseTo(plan.fadeDurationSeconds + 5, 6);
    expect(viz.outgoing.beatTimesSeconds.some((t) => t < viz.rampStartSeconds)).toBe(true);
    expect(viz.incoming.beatTimesSeconds.some((t) => t > plan.fadeDurationSeconds)).toBe(true);
    // Outgoing has already faded out and stopped playing after the transition.
    expect(viz.outgoing.beatTimesSeconds.some((t) => t > plan.fadeDurationSeconds)).toBe(false);
    // Incoming hasn't started yet before the fade begins.
    expect(viz.incoming.beatTimesSeconds.some((t) => t < 0)).toBe(false);
  });

  it('collapses the ramp window to zero width when no ramp is needed (matched or incoming-side speed-up)', () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };
    const plan = computeTransitionPlan(outgoing, incoming, 5);

    const viz = computeCrossfadeVisualization(plan, 120, 120);

    expect(viz.rampStartSeconds).toBeCloseTo(viz.rampEndSeconds, 9);
    expect(viz.rampStartSeconds).toBeCloseTo(0, 9); // -0 is numerically fine here (rampDuration + beatWait both 0)
  });

  it('returns no beats (not a crash) when a bpm is unusable', () => {
    const outgoing = { endWindow: { bpm: 0, bpmConfidence: 0, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 128, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };
    const plan = computeTransitionPlan(outgoing, incoming, 5);

    expect(() => computeCrossfadeVisualization(plan, 0, 128)).not.toThrow();
    expect(computeCrossfadeVisualization(plan, 0, 128).outgoing.beatTimesSeconds).toEqual([]);
  });
});
