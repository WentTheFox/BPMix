import { describe, expect, it } from 'vitest';
import { computeTransitionPlan } from './computeTransitionPlan';

const RAMP_DURATION_SECONDS = 20; // matches the module's own constant

describe('computeTransitionPlan', () => {
  describe('when the outgoing track is slower (needs to speed up)', () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 150 }, durationSeconds: 300 };
    const incoming = { startWindow: { bpm: 128, bpmConfidence: 0.9, beatAnchorSeconds: 3 } };

    it('ramps the outgoing track to converge on the incoming tempo, never the incoming track', () => {
      const plan = computeTransitionPlan(outgoing, incoming, 5);

      const effectiveOutgoingBpmAtEnd = outgoing.endWindow.bpm * plan.outgoingTargetRate;
      expect(effectiveOutgoingBpmAtEnd).toBeCloseTo(incoming.startWindow.bpm, 5);
      expect(plan.incomingRate).toBe(1); // the already-faster track needs no change
      expect(plan.rampDurationSeconds).toBe(RAMP_DURATION_SECONDS);
    });

    it("snaps the ramp start to a beat on the outgoing track's own grid, well before the fade", () => {
      const plan = computeTransitionPlan(outgoing, incoming, 5);

      // period = 0.5s at 120bpm - the start must land exactly on the beat grid anchored at 150s.
      const stepsFromAnchor = (plan.rampStartSeconds - 150) / 0.5;
      expect(stepsFromAnchor).toBeCloseTo(Math.round(stepsFromAnchor), 9);
      // Nominal target accounts for track-time consumed at the ramp's
      // averaged rate and the fade's held rate, not just real seconds:
      // 300 - (20*(1+1.0667)/2 + 5*1.0667) = 300 - 26 = 274.
      expect(plan.rampStartSeconds).toBeGreaterThan(273);
      expect(plan.rampStartSeconds).toBeLessThan(275);
    });

    it('computes a beatWaitSeconds that lands the outgoing track exactly on one of its own beats once the ramp completes', () => {
      const plan = computeTransitionPlan(outgoing, incoming, 5);

      const outgoingPeriod = 60 / outgoing.endWindow.bpm;
      const posAtRampEnd = plan.rampStartSeconds + (plan.rampDurationSeconds * (1 + plan.outgoingTargetRate)) / 2;
      const posAtFadeStart = posAtRampEnd + plan.beatWaitSeconds * plan.outgoingTargetRate;
      const stepsFromAnchor = (posAtFadeStart - outgoing.endWindow.beatAnchorSeconds) / outgoingPeriod;
      expect(stepsFromAnchor).toBeCloseTo(Math.round(stepsFromAnchor), 6);
      expect(plan.beatWaitSeconds).toBeGreaterThanOrEqual(0);
      expect(plan.beatWaitSeconds).toBeLessThan(outgoingPeriod); // never waits a whole extra period unnecessarily
    });
  });

  describe('when the incoming track is slower (it speeds up instead of slowing the outgoing track down)', () => {
    const outgoing = { endWindow: { bpm: 128, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 200 };
    const incoming = { startWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };

    it('never asks the outgoing track to slow down - it stays at rate 1 and the incoming track catches up instead', () => {
      const plan = computeTransitionPlan(outgoing, incoming, 5);

      expect(plan.outgoingTargetRate).toBe(1); // never < 1 - see the module doc on why
      expect(plan.rampDurationSeconds).toBe(0); // no ramp phase needed at all
      expect(plan.beatWaitSeconds).toBe(0);
      const effectiveIncomingBpmAtStart = incoming.startWindow.bpm * plan.incomingRate;
      expect(effectiveIncomingBpmAtStart).toBeCloseTo(outgoing.endWindow.bpm, 5);
    });

    it('collapses back to a single beat-aligned fade with no separate ramp phase', () => {
      const plan = computeTransitionPlan(outgoing, incoming, 5);

      // Nominal target: duration - (0 + 5) = 195, on outgoing's beat grid (period 60/128).
      const outgoingPeriod = 60 / outgoing.endWindow.bpm;
      const stepsFromAnchor = (plan.rampStartSeconds - 0) / outgoingPeriod;
      expect(stepsFromAnchor).toBeCloseTo(Math.round(stepsFromAnchor), 9);
      expect(plan.rampStartSeconds).toBeGreaterThan(194);
      expect(plan.rampStartSeconds).toBeLessThan(196);
    });
  });

  it('fits the whole ramp+fade sequence inside the track even with a large tempo gap (regression: on-device the transition ran past the actual track end and cut off audibly)', () => {
    // The exact scenario that reproduced it: a big BPM gap (66 -> 115, a
    // 1.74x ramp) on a track just long enough that naively treating the
    // ramp as consuming only its real-time duration (not the larger
    // track-time it actually eats at rate > 1) put the ramp+fade past the
    // track's actual end.
    const outgoing = { endWindow: { bpm: 66, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 178 };
    const incoming = { startWindow: { bpm: 115, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };

    const plan = computeTransitionPlan(outgoing, incoming, 8);

    const rampTrackTimeConsumed = (plan.rampDurationSeconds * (1 + plan.outgoingTargetRate)) / 2;
    const fadeTrackTimeConsumed = plan.fadeDurationSeconds * plan.outgoingTargetRate;
    const trackPositionAtFadeEnd =
      plan.rampStartSeconds + rampTrackTimeConsumed + plan.beatWaitSeconds * plan.outgoingTargetRate + fadeTrackTimeConsumed;
    expect(trackPositionAtFadeEnd).toBeLessThanOrEqual(outgoing.durationSeconds + 1e-6);
  });

  it("treats a low-confidence bpm estimate as unusable, falling back to a plain fade instead of ramping toward a likely-wrong target (regression: a track whose beat doesn't kick in until well into the analyzed window - e.g. a vocal-only intro - can still produce a confident-looking bpm number that's actually a misdetection)", () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 200 };
    // A real bpm, but low confidence - e.g. a sparse/non-percussive intro
    // the comb filter couldn't lock onto reliably.
    const incoming = { startWindow: { bpm: 200, bpmConfidence: 0.05, beatAnchorSeconds: 0 } };

    const plan = computeTransitionPlan(outgoing, incoming, 5);

    expect(plan.outgoingTargetRate).toBe(1); // did NOT ramp toward the suspect 200bpm
    expect(plan.incomingRate).toBe(1);
    expect(plan.rampDurationSeconds).toBe(0);
  });

  it('still ramps normally when both estimates are confident, even if one is much lower confidence than the other but still above the floor', () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 200 };
    const incoming = { startWindow: { bpm: 128, bpmConfidence: 0.2, beatAnchorSeconds: 0 } }; // above MIN_BPM_CONFIDENCE

    const plan = computeTransitionPlan(outgoing, incoming, 5);

    expect(plan.outgoingTargetRate).toBeCloseTo(128 / 120, 6);
  });

  it('snaps the incoming start to the earliest beat at or after 0 on its own grid', () => {
    // Anchor is behind 0 by a non-whole number of periods - the earliest beat >= 0 must still land on-grid.
    const outgoing = { endWindow: { bpm: 100, bpmConfidence: 0.9, beatAnchorSeconds: 100 }, durationSeconds: 200 };
    const incoming = { startWindow: { bpm: 90, bpmConfidence: 0.9, beatAnchorSeconds: -1.2 } };

    const plan = computeTransitionPlan(outgoing, incoming, 4);

    const period = 60 / 90;
    const stepsFromAnchor = (plan.incomingStartSeconds - -1.2) / period;
    expect(stepsFromAnchor).toBeCloseTo(Math.round(stepsFromAnchor), 9);
    expect(plan.incomingStartSeconds).toBeGreaterThanOrEqual(0);
    expect(plan.incomingStartSeconds).toBeLessThan(period); // the *earliest* qualifying beat, not just any
  });

  it('uses the requested crossfade duration as-is for the fade phase', () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };

    const plan = computeTransitionPlan(outgoing, incoming, 7);

    expect(plan.fadeDurationSeconds).toBe(7);
  });

  it('never starts the ramp/fade phase before 0 or past the track duration', () => {
    const shortOutgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 3 };
    const incoming = { startWindow: { bpm: 128, bpmConfidence: 0.9, beatAnchorSeconds: 0 } }; // faster - forces a ramp

    const plan = computeTransitionPlan(shortOutgoing, incoming, 10); // ramp+fade far longer than the whole track

    expect(plan.rampStartSeconds).toBeGreaterThanOrEqual(0);
    expect(plan.rampStartSeconds).toBeLessThanOrEqual(shortOutgoing.durationSeconds);
  });

  it('falls back to rate 1 on both sides (no ramp, no wait) when either track has no usable bpm estimate', () => {
    const outgoing = { endWindow: { bpm: 0, bpmConfidence: 0, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 128, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };

    const plan = computeTransitionPlan(outgoing, incoming, 5);

    expect(plan.outgoingTargetRate).toBe(1);
    expect(plan.incomingRate).toBe(1);
    expect(plan.rampDurationSeconds).toBe(0);
    expect(plan.beatWaitSeconds).toBe(0);
  });

  it('does not ramp or wait when both tracks already share the same tempo', () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };

    const plan = computeTransitionPlan(outgoing, incoming, 5);

    expect(plan.outgoingTargetRate).toBe(1);
    expect(plan.incomingRate).toBe(1);
    expect(plan.rampDurationSeconds).toBe(0);
    expect(plan.beatWaitSeconds).toBe(0);
  });

  it('does not throw on a negative or zero crossfade duration - clamps to 0', () => {
    const outgoing = { endWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 }, durationSeconds: 180 };
    const incoming = { startWindow: { bpm: 120, bpmConfidence: 0.9, beatAnchorSeconds: 0 } };

    expect(() => computeTransitionPlan(outgoing, incoming, -3)).not.toThrow();
    expect(computeTransitionPlan(outgoing, incoming, -3).fadeDurationSeconds).toBe(0);
  });
});
