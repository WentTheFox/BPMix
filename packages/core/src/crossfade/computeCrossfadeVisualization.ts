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
  /** The full visible timeline (seconds, relative to the fade start at t=0). */
  timelineStartSeconds: number;
  timelineEndSeconds: number;
  /**
   * Always equal (a zero-width "ramp" phase) - kept only so
   * CrossfadePreview's existing ramp-phase rendering (dashed box, "ramp,
   * then fade" label) degrades to its already-correct "fade only" path
   * with no changes there. No rate ramp exists this round - see
   * computeTransitionPlan's doc.
   */
  rampStartSeconds: number;
  rampEndSeconds: number;
  /** The audible gain crossfade spans [0, fadeDurationSeconds] within the timeline. */
  fadeDurationSeconds: number;
  outgoing: TrackVisualization;
  incoming: TrackVisualization;
}

export interface CrossfadeVisualizationOptions {
  /** How many seconds of the outgoing track's normal playback (before the fade) to include for context. */
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
 * track's *own* track-time position reaches targetTrackPosition. Both
 * tracks play at a constant rate 1 throughout (no rate ramp this round -
 * see computeTransitionPlan's doc), so this is just a linear offset from
 * fadeStartSeconds. Exported so callers with a live playback position (e.g.
 * a debug preview's progress line) can convert it into this same timeline.
 */
export function realTimeForOutgoingPosition(plan: TransitionPlan, targetTrackPosition: number): number {
  return targetTrackPosition - plan.fadeStartSeconds;
}

function beatTimesForOutgoing(bpm: number, plan: TransitionPlan, timelineStartSeconds: number): number[] {
  if (bpm <= 0) return [];
  const period = 60 / bpm;
  const times: number[] = [];
  for (let n = 0; ; n++) {
    const t = n * period;
    if (t > plan.fadeDurationSeconds + 1e-9) break;
    if (t >= timelineStartSeconds - 1e-9) times.push(t);
    if (n > 2000) break; // safety valve - should never be reached at any sane bpm/timeline size
  }
  for (let n = -1; ; n--) {
    const t = n * period;
    if (t < timelineStartSeconds - 1e-9) break;
    times.unshift(t);
    if (n < -2000) break;
  }
  return times;
}

function beatTimesForIncoming(bpm: number, plan: TransitionPlan, timelineEndSeconds: number): number[] {
  if (bpm <= 0) return [];
  const period = 60 / bpm;
  const times: number[] = [];
  for (let n = 0; ; n++) {
    const t = n * period;
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
 * normal playback before the fade begins and after it completes, for
 * context - without it, the transition alone just looks like an arbitrary
 * shape with no anchor for what's actually changing.
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
  const timelineStartSeconds = -contextBefore;
  const timelineEndSeconds = plan.fadeDurationSeconds + contextAfter;

  return {
    timelineStartSeconds,
    timelineEndSeconds,
    rampStartSeconds: 0,
    rampEndSeconds: 0,
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
