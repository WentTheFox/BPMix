import type { WindowAnalysis } from '../library-store/types';

export interface TransitionPlan {
  /**
   * Position (seconds) in the OUTGOING track's own timeline where phase 1
   * begins - beat-snapped. If rampDurationSeconds is 0 (no ramp needed),
   * this is directly where the fade starts too (no separate ramp phase).
   */
  rampStartSeconds: number;
  /**
   * How long the outgoing track's rate ramp itself lasts (real seconds) -
   * 0 when the outgoing track doesn't need to change tempo at all (either
   * the BPMs already match, or the incoming track is the slower one and
   * gets sped up instead - see incomingRate). Nothing from the incoming
   * track is audible during this phase.
   */
  rampDurationSeconds: number;
  /**
   * Extra real seconds after the ramp completes, before the fade starts -
   * waiting for the outgoing track's own beat grid to land on an actual
   * beat once it's already at the target tempo, so the fade begins
   * phase-locked (beats coincide), not just tempo-matched. Always 0 when
   * rampDurationSeconds is 0, since an unramped track's beat grid is
   * already fully predictable - no waiting needed to land on one exactly.
   */
  beatWaitSeconds: number;
  /**
   * Outgoing's rate from rampStartSeconds onward (ramping to this value
   * over rampDurationSeconds, then held constant through the fade) - 1 if
   * the outgoing track doesn't need to speed up.
   */
  outgoingTargetRate: number;
  /**
   * Incoming's playback rate from its very first sample - always constant,
   * never ramped, since the incoming source hasn't started playing yet
   * when this is chosen, so there's no in-progress playback to smoothly
   * transition from/to. >=1 when the incoming track is the slower one and
   * needs to catch up to the outgoing track's tempo; 1 otherwise.
   *
   * Only one of outgoingTargetRate/incomingRate is ever above 1 - the
   * slower-BPM track is always the one sped up to meet the faster one,
   * never the other way around: slowing a track down (rate < 1) via the
   * WSOLA time-stretcher tends to produce audible stepping/warble
   * artifacts that speeding up doesn't, so this plan never asks for it.
   */
  incomingRate: number;
  /** Position (seconds) in the INCOMING track to start playback from - snapped to its own beat grid. */
  incomingStartSeconds: number;
  /** How long the audible gain crossfade itself lasts (seconds), once both tracks are tempo+phase matched. */
  fadeDurationSeconds: number;
}

export interface TrackTransitionInfo {
  endWindow: WindowAnalysis;
  /** Total decoded duration of the track (seconds). */
  durationSeconds: number;
}

export interface IncomingTransitionInfo {
  startWindow: WindowAnalysis;
}

/** The beat (from a grid defined by one known anchor + period) nearest to targetSeconds. */
function nearestBeat(anchorSeconds: number, periodSeconds: number, targetSeconds: number): number {
  if (periodSeconds <= 0) return targetSeconds;
  const steps = Math.round((targetSeconds - anchorSeconds) / periodSeconds);
  return anchorSeconds + steps * periodSeconds;
}

/** The earliest beat (from the same kind of grid) at or after minSeconds. */
function earliestBeatAtOrAfter(anchorSeconds: number, periodSeconds: number, minSeconds: number): number {
  if (periodSeconds <= 0) return Math.max(anchorSeconds, minSeconds);
  const steps = Math.ceil((minSeconds - anchorSeconds) / periodSeconds);
  return anchorSeconds + steps * periodSeconds;
}

/** Positive modulo (JS's % can return negative for a negative dividend). */
function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * How long the rate ramp itself lasts, deliberately decoupled from the
 * (much shorter, typically 1-20s) fade duration - a tempo change spread
 * over just a few seconds is jarring even when it's only a speed-up.
 * Starting the ramp this far ahead of the fade means it's essentially
 * imperceptible by the time the incoming track actually becomes audible.
 */
export const RAMP_DURATION_SECONDS = 20;

/**
 * Computes a BPM-matched crossfade transition plan between two tracks, per
 * Stage 7 of the plan, refined twice after actually hearing it on-device:
 *
 * 1. The transition is split into two real-time phases instead of running
 *    the rate ramp and the gain fade simultaneously: first the tempo
 *    converges (ramp phase, nothing from the incoming track audible yet),
 *    then - once the outgoing track's own beat grid lands on an actual
 *    beat at the now-matched tempo - the audible gain fade begins. Running
 *    them together meant the two tracks were only ever at the same tempo
 *    right as the outgoing one went silent - exactly when the audible
 *    overlap most needed them to already match.
 * 2. Whichever track has the LOWER bpm is the one sped up to meet the
 *    other's tempo - never the other way around, since slowing a track
 *    down produces more audible WSOLA time-stretch artifacts than speeding
 *    one up. If that's the incoming track, it simply starts at the already
 *    -matched constant rate from its first sample (no ramp needed at all,
 *    since it isn't playing yet - there's nothing already in motion to
 *    smoothly transition from), and the outgoing track needs no ramp
 *    phase either, collapsing this back to a single beat-aligned fade with
 *    no waiting, same as when the BPMs already match.
 *
 * Both start points are snapped to their own track's beat grid from a
 * single beat-anchor + BPM (not a full continuous beat tracker) - still
 * the "rudimentary" version the plan calls for, just phase-locked for the
 * actual audible overlap instead of only tempo-converged by the end of it.
 */
/**
 * Below this, estimateBpm's own confidence score (peak autocorrelation
 * strength - see its doc) means the detected bpm is more likely a
 * misdetection than a real tempo: a weak/sparse-onset intro or outro (no
 * distinct beats for the comb filter to lock onto) tends to produce a
 * low-confidence estimate that can still be numerically far from the
 * track's actual tempo, which would otherwise get trusted just as much as
 * a high-confidence one and ramp toward a musically nonsensical target
 * rate. A clean, clearly periodic signal scores meaningfully higher than
 * this in practice (see bpm.test.ts's synthetic click-track case); this
 * is a starting heuristic, not a calibrated number - revisit if real
 * tracks turn out to sit close to this line either way.
 */
const MIN_BPM_CONFIDENCE = 0.15;

export function computeTransitionPlan(
  outgoing: TrackTransitionInfo,
  incoming: IncomingTransitionInfo,
  crossfadeSeconds: number,
): TransitionPlan {
  const fadeDurationSeconds = Math.max(0, crossfadeSeconds);
  const outgoingBpm = outgoing.endWindow.bpmConfidence >= MIN_BPM_CONFIDENCE ? outgoing.endWindow.bpm : 0;
  const incomingBpm = incoming.startWindow.bpmConfidence >= MIN_BPM_CONFIDENCE ? incoming.startWindow.bpm : 0;
  const outgoingPeriod = outgoingBpm > 0 ? 60 / outgoingBpm : 0;
  const incomingPeriod = incomingBpm > 0 ? 60 / incomingBpm : 0;
  const bothUsable = outgoingBpm > 0 && incomingBpm > 0;

  const needsOutgoingRamp = bothUsable && outgoingBpm < incomingBpm;
  const outgoingTargetRate = needsOutgoingRamp ? incomingBpm / outgoingBpm : 1;
  const incomingRate = bothUsable && incomingBpm < outgoingBpm ? outgoingBpm / incomingBpm : 1;
  const rampDurationSeconds = needsOutgoingRamp ? RAMP_DURATION_SECONDS : 0;

  // How much of the outgoing track's OWN buffer (track-time, not real time)
  // the ramp and fade phases actually consume - at rate > 1 this is more
  // than their real-time durations, since track-time advances faster than
  // real time. Getting this wrong (treating it as if rate were always 1)
  // meant a large tempo gap could schedule the ramp/fade to run past the
  // track's actual end, cutting the transition off mid-stretch instead of
  // completing it - the bigger the tempo gap, the worse the miscalculation.
  const rampTrackTimeConsumed = (rampDurationSeconds * (1 + outgoingTargetRate)) / 2;
  const fadeTrackTimeConsumed = fadeDurationSeconds * outgoingTargetRate; // outgoing holds this rate through the fade too
  // The beat-alignment wait after the ramp (computed below, from
  // rampStartSeconds) also eats a bit more of the track's own buffer - up
  // to one full outgoing beat period's worth - so reserve that margin here
  // too, or the same "ran past the end" bug reappears in miniature.
  const nominalRampStart = Math.max(
    0,
    outgoing.durationSeconds - (rampTrackTimeConsumed + fadeTrackTimeConsumed + outgoingPeriod),
  );
  const snappedRampStart = nearestBeat(outgoing.endWindow.beatAnchorSeconds, outgoingPeriod, nominalRampStart);
  const rampStartSeconds = Math.max(0, Math.min(snappedRampStart, outgoing.durationSeconds));

  let beatWaitSeconds = 0;
  if (needsOutgoingRamp && outgoingPeriod > 0) {
    // Where the ramp leaves the outgoing track's own-timeline position,
    // using the ramp's average rate (it's linear from 1 to outgoingTargetRate).
    const outgoingPositionAtRampEnd = rampStartSeconds + (rampDurationSeconds * (1 + outgoingTargetRate)) / 2;
    const phaseIntoGrid = mod(outgoingPositionAtRampEnd - outgoing.endWindow.beatAnchorSeconds, outgoingPeriod);
    const EPS = 1e-6;
    const trackTimeToNextBeat = phaseIntoGrid < EPS ? 0 : outgoingPeriod - phaseIntoGrid;
    // trackTimeToNextBeat is in the outgoing track's own (buffer) time -
    // convert to real seconds at the now-held target rate.
    beatWaitSeconds = trackTimeToNextBeat / outgoingTargetRate;
  }

  const incomingStartSeconds = Math.max(0, earliestBeatAtOrAfter(incoming.startWindow.beatAnchorSeconds, incomingPeriod, 0));

  return {
    rampStartSeconds,
    rampDurationSeconds,
    beatWaitSeconds,
    outgoingTargetRate,
    incomingRate,
    incomingStartSeconds,
    fadeDurationSeconds,
  };
}
