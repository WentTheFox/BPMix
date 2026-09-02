import type { TransitionPlan } from './computeTransitionPlan';
import { equalPowerGain } from './equalPowerGain';

export interface TrackVisualization {
  bpm: number;
  /** Gain samples over [timelineStartSeconds, timelineEndSeconds], evenly spaced. */
  gainCurve: number[];
  /** Beat timestamps (seconds, relative to the fade start at t=0) within [timelineStartSeconds, timelineEndSeconds]. */
  beatTimesSeconds: number[];
}

export interface CrossfadeVisualization {
  /** The full visible timeline (seconds, relative to the fade start at t=0) - negative covers the ramp phase and pre-ramp context. */
  timelineStartSeconds: number;
  /** The full visible timeline's end (seconds, relative to t=0) - past fadeDurationSeconds is post-fade context. */
  timelineEndSeconds: number;
  /** Where the outgoing track's rate ramp begins/ends (both <= 0) - equal (a zero-width phase) when no ramp is needed. */
  rampStartSeconds: number;
  rampEndSeconds: number;
  /** The audible gain crossfade spans [0, fadeDurationSeconds] within the timeline. */
  fadeDurationSeconds: number;
  outgoing: TrackVisualization;
  incoming: TrackVisualization;
}

export interface CrossfadeVisualizationOptions {
  /** How many seconds of the outgoing track's normal playback (before the ramp even begins) to include for context. */
  contextSecondsBefore?: number;
  /** How many seconds of the incoming track's normal (post-fade) playback to include for context. */
  contextSecondsAfter?: number;
  /** How many points to sample each gain curve at. */
  sampleCount?: number;
}

const DEFAULT_CONTEXT_SECONDS = 5;
const DEFAULT_SAMPLE_COUNT = 60;

/**
 * Real time (relative to the fade start at t=0) at which the outgoing
 * track's *own* track-time position reaches targetTrackPosition, across
 * all three of its phases: constant rate 1 before the ramp, the linear
 * ramp itself (a quadratic position-vs-time relationship, since the rate
 * is changing), then held constant at outgoingTargetRate from the ramp's
 * end through the fade. Exported so callers with a live playback position
 * (e.g. a debug preview's progress line) can convert it into this same
 * timeline exactly, instead of a linear approximation that would be wrong
 * specifically while inside the ramp.
 */
export function realTimeForOutgoingPosition(plan: TransitionPlan, targetTrackPosition: number): number | null {
  const rampVizStart = -(plan.rampDurationSeconds + plan.beatWaitSeconds);
  const rampVizEnd = -plan.beatWaitSeconds;
  const posAtRampStart = plan.rampStartSeconds;
  const posAtRampEnd = plan.rampStartSeconds + (plan.rampDurationSeconds * (1 + plan.outgoingTargetRate)) / 2;

  if (targetTrackPosition <= posAtRampStart) {
    return rampVizStart + (targetTrackPosition - posAtRampStart); // constant rate 1
  }

  const rateChange = plan.outgoingTargetRate - 1;
  const isRamping = plan.rampDurationSeconds > 0 && Math.abs(rateChange) > 1e-9;
  if (isRamping && targetTrackPosition <= posAtRampEnd) {
    const a = rateChange / (2 * plan.rampDurationSeconds);
    const b = 1;
    const c = posAtRampStart - targetTrackPosition;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const sqrtDiscriminant = Math.sqrt(discriminant);
    const t1 = (-b + sqrtDiscriminant) / (2 * a);
    const t2 = (-b - sqrtDiscriminant) / (2 * a);
    const candidates = [t1, t2].filter((t) => t >= -1e-9 && t <= plan.rampDurationSeconds + 1e-9);
    if (candidates.length === 0) return null;
    return rampVizStart + Math.min(...candidates);
  }

  // Past the ramp (or there was none) - held at outgoingTargetRate (1 if no ramp).
  if (plan.outgoingTargetRate <= 0) return null;
  return rampVizEnd + (targetTrackPosition - posAtRampEnd) / plan.outgoingTargetRate;
}

/**
 * Beat times across the full [timelineStart, timelineEnd] window.
 * Outgoing is silent/stopped past fadeDurationSeconds, so no beats are
 * produced there. Incoming plays at a constant rate (incomingRate) from
 * t=0 onward - silent/not started before that.
 */
function beatTimesForOutgoing(
  bpm: number,
  plan: TransitionPlan,
  timelineStartSeconds: number,
): number[] {
  if (bpm <= 0) return [];
  const period = 60 / bpm;
  const times: number[] = [];

  for (let n = 0; ; n++) {
    const trackPosition = plan.rampStartSeconds + n * period;
    const t = realTimeForOutgoingPosition(plan, trackPosition);
    if (t === null || t > plan.fadeDurationSeconds + 1e-9) break;
    if (t >= timelineStartSeconds - 1e-9) times.push(t);
    if (n > 2000) break; // safety valve - should never be reached at any sane bpm/timeline size
  }
  for (let n = -1; ; n--) {
    const trackPosition = plan.rampStartSeconds + n * period;
    const t = trackPosition - plan.rampStartSeconds; // before the ramp is always rate 1
    if (t < timelineStartSeconds - 1e-9) break;
    times.unshift(t);
    if (n < -2000) break;
  }
  return times;
}

function beatTimesForIncoming(
  bpm: number,
  plan: TransitionPlan,
  timelineEndSeconds: number,
): number[] {
  if (bpm <= 0) return [];
  const period = 60 / bpm;
  const times: number[] = [];
  for (let n = 0; ; n++) {
    const trackPosition = plan.incomingStartSeconds + n * period;
    const t = (trackPosition - plan.incomingStartSeconds) / plan.incomingRate;
    if (t > timelineEndSeconds + 1e-9) break;
    times.push(t);
    if (n > 2000) break;
  }
  return times;
}

function sampleGainCurve(
  timelineStartSeconds: number,
  timelineEndSeconds: number,
  fadeDurationSeconds: number,
  isOutgoing: boolean,
  sampleCount: number,
): number[] {
  const curve: number[] = [];
  const span = timelineEndSeconds - timelineStartSeconds;
  for (let i = 0; i <= sampleCount; i++) {
    const t = timelineStartSeconds + (span > 0 ? (i / sampleCount) * span : 0);
    const fraction = fadeDurationSeconds > 0 ? t / fadeDurationSeconds : t >= 0 ? 1 : 0;
    curve.push(equalPowerGain(fraction, isOutgoing));
  }
  return curve;
}

/**
 * Sample data for rendering the crossfade - the same TransitionPlan that
 * drives actual playback scheduling, turned into something a debug view
 * can draw, so what's shown is provably the same math that will actually
 * run, not a separate approximation of it. Includes a few seconds of
 * normal playback before the ramp even begins and after the fade
 * completes, for context - without it, the transition alone just looks
 * like an arbitrary shape with no anchor for what's actually changing.
 */
export function computeCrossfadeVisualization(
  plan: TransitionPlan,
  outgoingBpm: number,
  incomingBpm: number,
  options: CrossfadeVisualizationOptions = {},
): CrossfadeVisualization {
  const contextBefore = options.contextSecondsBefore ?? DEFAULT_CONTEXT_SECONDS;
  const contextAfter = options.contextSecondsAfter ?? DEFAULT_CONTEXT_SECONDS;
  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const rampStartSeconds = -(plan.rampDurationSeconds + plan.beatWaitSeconds);
  const rampEndSeconds = -plan.beatWaitSeconds;
  const timelineStartSeconds = rampStartSeconds - contextBefore;
  const timelineEndSeconds = plan.fadeDurationSeconds + contextAfter;

  return {
    timelineStartSeconds,
    timelineEndSeconds,
    rampStartSeconds,
    rampEndSeconds,
    fadeDurationSeconds: plan.fadeDurationSeconds,
    outgoing: {
      bpm: outgoingBpm,
      gainCurve: sampleGainCurve(timelineStartSeconds, timelineEndSeconds, plan.fadeDurationSeconds, true, sampleCount),
      beatTimesSeconds: beatTimesForOutgoing(outgoingBpm, plan, timelineStartSeconds),
    },
    incoming: {
      bpm: incomingBpm,
      gainCurve: sampleGainCurve(timelineStartSeconds, timelineEndSeconds, plan.fadeDurationSeconds, false, sampleCount),
      beatTimesSeconds: beatTimesForIncoming(incomingBpm, plan, timelineEndSeconds),
    },
  };
}
