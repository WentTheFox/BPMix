import { describe, expect, it } from 'vitest';
import { computeTransitionPlan } from '../../crossfade/computeTransitionPlan';
import { realTimeForOutgoingPosition } from '../../crossfade/computeCrossfadeVisualization';
import { equalPowerGain } from '../../crossfade/equalPowerGain';
import { idlePlayerState } from '../testing';
import { computeFastDisplay } from './fastDisplay';

type Pending = { positionSeconds: number; durationSeconds: number; fadeDurationSeconds: number } | null;
const state = (status: 'playing' | 'paused' | 'idle', positionSeconds: number, durationSeconds: number, pendingIncoming: Pending = null) =>
  idlePlayerState({ currentFileId: 'a', track: { status, isAudible: status === 'playing', positionSeconds, durationSeconds, pendingIncoming } });

describe('computeFastDisplay', () => {
  it('shows the current track\'s position and duration, with progress through it', () => {
    const d = computeFastDisplay(state('playing', 50, 200), 8);
    expect(d).toMatchObject({ displayPositionSeconds: 50, displayDurationSeconds: 200, outgoingProgress: 0.25 });
  });

  it('has zero progress for a track with no known duration, and no crossfade preview', () => {
    const d = computeFastDisplay(state('playing', 0, 0), 8);
    expect(d.outgoingProgress).toBe(0);
    expect(d.outgoingGain).toBe(1);
    expect(d.incomingGain).toBe(0);
  });

  it('is fully the outgoing track well before the crossfade window, and fully the incoming one after it', () => {
    const early = computeFastDisplay(state('playing', 10, 200), 8);
    expect(early.outgoingGain).toBeCloseTo(1);
    expect(early.incomingGain).toBeCloseTo(0);
    const late = computeFastDisplay(state('playing', 199.9, 200), 8);
    expect(late.outgoingGain).toBeLessThan(0.1);
    expect(late.incomingGain).toBeGreaterThan(0.9);
  });

  it('samples the same equal-power curve the audio fade uses, at the progress through the preview window', () => {
    const plan = computeTransitionPlan(200, 8);
    const fraction = realTimeForOutgoingPosition(plan, 196) / plan.fadeDurationSeconds;
    const d = computeFastDisplay(state('playing', 196, 200), 8);
    expect(d.outgoingGain).toBeCloseTo(equalPowerGain(fraction, true, plan.fadeDurationSeconds));
    expect(d.incomingGain).toBeCloseTo(equalPowerGain(fraction, false, plan.fadeDurationSeconds));
  });

  it('mutes the outgoing track when paused', () => {
    expect(computeFastDisplay(state('paused', 10, 200), 8).outgoingGain).toBe(0);
  });

  it('during a crossfade, switches the display to the incoming track and samples the curve over its real fade length', () => {
    const d = computeFastDisplay(state('playing', 195, 200, { positionSeconds: 0.5, durationSeconds: 300, fadeDurationSeconds: 1 }), 8);
    expect(d.displayPositionSeconds).toBe(0.5);
    expect(d.displayDurationSeconds).toBe(300);
    // The tonearm keeps following the outgoing track itself.
    expect(d.outgoingProgress).toBeCloseTo(195 / 200);
    expect(d.outgoingGain).toBeCloseTo(equalPowerGain(0.5, true, 1));
    expect(d.incomingGain).toBeCloseTo(equalPowerGain(0.5, false, 1));
  });

  it('keeps the outgoing gain up mid-crossfade even if the status reads paused (a crossfade implies playing)', () => {
    const d = computeFastDisplay(state('paused', 195, 200, { positionSeconds: 0.1, durationSeconds: 300, fadeDurationSeconds: 1 }), 8);
    expect(d.outgoingGain).toBeGreaterThan(0.9);
  });
});
