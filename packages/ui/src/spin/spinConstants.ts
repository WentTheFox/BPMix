/**
 * Full turns a disc makes over the course of an entire track (progress 0
 * to 1) - used both to convert a moment-in-time progress value into an
 * angle (for anchoring the spin correctly whenever it starts/restarts)
 * and to convert a real playback rate into a turnsPerSecond value the
 * spin animation actually runs continuously at (see useSpin's doc).
 */
export const TURNS_PER_SONG = 30;

/**
 * Native leg length (a single Animated.timing call's fixed wall-clock
 * duration) for useSpin.ts - NOT scaled by rate, unlike an earlier version
 * of this that fixed a number of *turns* per leg instead: at a very low
 * turnsPerSecond, that came out to a leg duration of tens of millions of
 * ms in one Animated.timing call, and RN precomputes a per-frame easing
 * lookup table sized by duration/frameDuration even under
 * useNativeDriver - at that duration the table's element count overflowed
 * what the engine could allocate ("Requested an array size that fails to
 * allocate"), crashing the app outright. A fixed *duration* keeps that
 * table bounded regardless of rate.
 */
export const NATIVE_SPIN_LEG_MS = 20000;
