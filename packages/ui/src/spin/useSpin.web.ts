import { useMemo } from 'react';
import { BASE_SPIN_MS, bucketedSpinRate } from './spinConstants';

/**
 * A single, static @keyframes rotation shared by every spinning disc -
 * only animationDuration/animationDelay (set per-disc below) ever change,
 * so one keyframe definition is all that's needed.
 */
const SPIN_KEYFRAMES = [{ '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } }];

/**
 * Persists each disc's current rotation angle across a mount/unmount (e.g.
 * the current-slot disc, which unmounts for a transition's ~450ms), keyed
 * by the caller-supplied spinId - a plain module-level Map, not React
 * state, since it's read/written outside any render (see below) and must
 * outlive the specific component instance that's rotating.
 */
interface SpinAnchor {
  /** performance.now() at which this disc was at startAngleDeg. */
  startTimeMs: number;
  startAngleDeg: number;
  durationMs: number;
}
const anchors = new Map<string, SpinAnchor>();

function currentAngle(anchor: SpinAnchor, nowMs: number): number {
  if (anchor.durationMs <= 0) return anchor.startAngleDeg;
  const elapsedMs = nowMs - anchor.startTimeMs;
  return (anchor.startAngleDeg + (elapsedMs / anchor.durationMs) * 360) % 360;
}

/**
 * Web disc spin - a plain CSS `animation` (react-native-web's
 * `animationKeyframes` style, which compiles down to a real @keyframes
 * rule) instead of a JS-driven Animated.Value ticking every frame. Only
 * animationDuration and a negative animationDelay (used to fast-forward
 * the animation's start point to wherever the disc's angle already was,
 * per spinId - see anchors above) ever change; the rotation itself runs
 * entirely on the browser's compositor thread with no JS involvement once
 * applied, which is the whole point versus useSpin.ts's native approach.
 */
export function useSpin(rate: number, spinId: string): object {
  const bucketedRate = bucketedSpinRate(rate);
  const durationMs = bucketedRate > 0 ? BASE_SPIN_MS / bucketedRate : 0;

  // Recomputed on every render where bucketedRate/durationMs actually
  // changed (useMemo's whole point here) - reading/writing `anchors` as a
  // side effect of a memo, not a useEffect, is deliberate: this has to run
  // (and land in `anchors`) before the very first paint of a new duration,
  // not one tick after, or the disc would visibly jump to angle 0 for one
  // frame before this "catches up".
  return useMemo(() => {
    const now = performance.now();
    const previous = anchors.get(spinId);
    const angleNow = previous ? currentAngle(previous, now) : 0;
    anchors.set(spinId, { startTimeMs: now, startAngleDeg: angleNow, durationMs });

    if (durationMs <= 0) {
      // Not spinning at all - freeze wherever it already was, same as the
      // native version's "return early, leave the Animated.Value alone".
      return { transform: [{ rotate: `${angleNow}deg` }] };
    }

    // A negative delay starts the animation as if it had already been
    // running for that long - i.e. already angleNow/360 of the way through
    // - so it picks up exactly where the previous duration's animation
    // left off instead of restarting from 0deg.
    const delayMs = -(angleNow / 360) * durationMs;
    return {
      animationKeyframes: SPIN_KEYFRAMES,
      animationDuration: `${durationMs}ms`,
      animationDelay: `${delayMs}ms`,
      animationTimingFunction: 'linear',
      animationIterationCount: 'infinite',
    };
    // spinId is stable for a disc's whole mounted lifetime (see call sites)
    // - only rate (via bucketedRate/durationMs) should ever retime this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketedRate, durationMs]);
}
