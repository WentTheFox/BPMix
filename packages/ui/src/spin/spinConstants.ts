/** Duration of one full turn at rate=1 (normal speed). */
export const BASE_SPIN_MS = 16000;
/** A disc never fully stops turning - even at rate≈0 it keeps a bare, slow rotation, so "next up" reads as queued rather than broken/frozen. */
export const MIN_SPIN_RATE = 0.12;
/** Spin rate is rounded to this granularity before retiming the animation - retiming on every ~200ms poll tick's tiny gain fluctuation would look jittery; only a genuinely audible speed change (mostly during an actual crossfade) should visibly re-time it. */
export const RATE_BUCKET = 0.2;

/**
 * rate<=0 means "not audible at all" (nothing playing) - genuinely stop
 * turning rather than applying MIN_SPIN_RATE, which is only meant to keep
 * an audible-but-quiet disc from looking frozen/broken.
 */
export function bucketedSpinRate(rate: number): number {
  return rate <= 0 ? 0 : Math.max(MIN_SPIN_RATE, Math.round(rate / RATE_BUCKET) * RATE_BUCKET);
}
