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
 * matches the actual ~200ms position-poll cadence both apps use (see each
 * App.tsx's setInterval), so the needle/disc reads as continuously turning
 * between ticks instead of stepping, without lagging behind. Was
 * mismatched at 1000ms for a while - imperceptible during ordinary
 * playback (progress barely changes within a second), but very visibly
 * out of sync with a fast rewindTo() effect, where position can swing
 * across a big chunk of the track in under a second and a 1s smoothing
 * window can't keep up.
 */
export const SPIN_UPDATE_MS = 200;
