export interface TransitionPlan {
  /** Position (seconds) in the OUTGOING track's own timeline where the audible gain crossfade begins - a fixed offset from the track's end, not beat-snapped. */
  fadeStartSeconds: number;
  /** How long the audible gain crossfade lasts (seconds). */
  fadeDurationSeconds: number;
  /** Position (seconds) in the INCOMING track to start playback from - always its very beginning for now. */
  incomingStartSeconds: number;
}

/**
 * Computes a crossfade transition plan between two tracks.
 *
 * This used to compute a beat-snapped tempo ramp too (see git history: the
 * outgoing track sped up/slowed down to match the incoming track's BPM
 * before the fade, both phase-locked from a whole-track pre-analysis).
 * Per CLAUDE.md's crossfade rework, rate/speed manipulation is dropped for
 * this round entirely - BPM matching becomes a live, "past few seconds"
 * concern for a later round, not something this plan computes up front. So
 * this is now just a fixed-lead-time, volume-only fade: no analysis input
 * needed at all, just durations.
 */
export function computeTransitionPlan(outgoingDurationSeconds: number, crossfadeSeconds: number): TransitionPlan {
  const fadeDurationSeconds = Math.max(0, crossfadeSeconds);
  const fadeStartSeconds = Math.max(0, outgoingDurationSeconds - fadeDurationSeconds);
  return {
    fadeStartSeconds,
    fadeDurationSeconds,
    incomingStartSeconds: 0,
  };
}
