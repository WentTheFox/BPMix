import { computeTransitionPlan } from '../../crossfade/computeTransitionPlan';
import { realTimeForOutgoingPosition } from '../../crossfade/computeCrossfadeVisualization';
import { equalPowerGain } from '../../crossfade/equalPowerGain';
import type { PlaylistPlayerState } from '../../playback/playlistPlayer';

/**
 * Everything the now-playing UI derives from the player's fast-moving state
 * (position, crossfade progress) - recomputed every tick, so it lives in the
 * few leaf components that draw it rather than at the app root. The slow
 * parts (which track, its art and title, whether it's playing) come from the
 * store's coarse mirror instead.
 */
export interface FastDisplay {
  /** The incoming track's position/duration during a crossfade (the display switches to it immediately, instead of the bar climbing toward the outgoing track's length and snapping back at the swap), else the current track's. */
  displayPositionSeconds: number;
  displayDurationSeconds: number;
  /** The outgoing track's own progress through itself, 0-1 - feeds the tonearm; it keeps advancing independently of any pending crossfade. */
  outgoingProgress: number;
  /** Equal-power gains sampled at the current crossfade progress - the same curve the real audio fade uses, so the art dissolves at exactly the rate the audio does (see CrossfadeArt). */
  outgoingGain: number;
  incomingGain: number;
}

export function computeFastDisplay(state: PlaylistPlayerState, crossfadeSeconds: number): FastDisplay {
  const { track } = state;
  const pendingIncoming = track.pendingIncoming;

  // While a crossfade is genuinely happening, reflect its real duration (a
  // manual skip's is much shorter than the natural end-of-track default), not
  // a static preview of a future one.
  const plan = pendingIncoming
    ? { fadeStartSeconds: 0, fadeDurationSeconds: pendingIncoming.fadeDurationSeconds, incomingStartSeconds: 0 }
    : track.durationSeconds > 0
      ? computeTransitionPlan(track.durationSeconds, crossfadeSeconds)
      : null;

  // The timeline is relative to the fade start (t=0). In flight,
  // pendingIncoming.positionSeconds IS that elapsed time directly; otherwise
  // it's a preview of a future natural-end crossfade from the outgoing position.
  const progressSeconds = pendingIncoming ? pendingIncoming.positionSeconds : plan ? realTimeForOutgoingPosition(plan, track.positionSeconds) : null;

  const fadeDurationSeconds = plan?.fadeDurationSeconds ?? 0;
  const fraction =
    progressSeconds == null ? null : fadeDurationSeconds > 0 ? progressSeconds / fadeDurationSeconds : progressSeconds >= 0 ? 1 : 0;

  // A crossfade only runs while playing, so pendingIncoming implies playing;
  // the override only matters when paused, where the outgoing gain must be 0
  // even though `fraction` is some out-of-range value there.
  const isPlaying = pendingIncoming ? true : track.status === 'playing';

  return {
    displayPositionSeconds: pendingIncoming ? pendingIncoming.positionSeconds : track.positionSeconds,
    displayDurationSeconds: pendingIncoming ? pendingIncoming.durationSeconds : track.durationSeconds,
    outgoingProgress: track.durationSeconds > 0 ? track.positionSeconds / track.durationSeconds : 0,
    outgoingGain: isPlaying ? (fraction == null ? 1 : equalPowerGain(fraction, true, fadeDurationSeconds)) : 0,
    incomingGain: fraction == null ? 0 : equalPowerGain(fraction, false, fadeDurationSeconds),
  };
}
