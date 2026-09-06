/**
 * Full turns a disc makes over the course of an entire track (progress 0
 * to 1) - rotation is a pure function of playback progress rather than an
 * open-ended animation, so it's always exactly consistent with how far
 * into the track playback actually is (and freezes cleanly on pause,
 * with no separate "stop turning" logic needed).
 */
export const TURNS_PER_SONG = 30;

/**
 * How long the rotation takes to ease to a newly-reported progress value -
 * matches the ~1s cadence position updates already arrive at, so the
 * needle/disc reads as continuously turning between ticks instead of
 * stepping.
 */
export const SPIN_UPDATE_MS = 1000;
