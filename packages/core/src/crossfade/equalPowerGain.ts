/**
 * How much a plain fraction*pi/2 angle's rate of change accelerates toward
 * the very end of [0,1] scales inversely with the fade's own duration - a
 * long fade's ending is already gentle in absolute (real-time) terms, but a
 * short one's isn't, and reads as an abrupt cutoff rather than a fade to
 * silence (confirmed on-device: fine at the natural end-of-track crossfade's
 * default ~8s duration, audibly abrupt at a manual skip's ~1s one). Rather
 * than a hard on/off threshold - which would make the curve's own shape
 * visibly discontinuous right at that boundary as crossfadeSeconds is
 * adjusted - easedFraction blends smoothly from the original shape (long
 * fades) toward the fully-eased one (very short fades), governed by this
 * reference duration: a fade at exactly this length is eased halfway.
 */
const EASE_REFERENCE_SECONDS = 1;

/** Blends `fraction` toward `2*fraction - fraction^2` (zero slope at both ends of [0,1], not just the start) by an amount that grows as durationSeconds shrinks - see EASE_REFERENCE_SECONDS' doc. */
function easedFraction(fraction: number, durationSeconds: number): number {
  const easeAmount = durationSeconds > 0 ? Math.min(1, EASE_REFERENCE_SECONDS / durationSeconds) : 1;
  return fraction + easeAmount * fraction * (1 - fraction);
}

/**
 * Equal-power crossfade gain at a given fraction [0,1] through a transition
 * of durationSeconds seconds. A straight linear fade (gain = fraction)
 * spends much of its duration sounding under-loud on the fading-in side
 * (and abruptly loud then long-tailed-quiet on the fading-out side), because
 * human loudness perception is roughly logarithmic, not linear in gain - a
 * 20s linear fade-in is still under 10% of its target gain 2 seconds in,
 * which reads as "not playing yet." The cos/sin pair here keeps
 * outgoing^2 + incoming^2 constant across the whole transition, so combined
 * perceived loudness stays roughly level instead of dipping in the middle.
 *
 * The fraction is eased (see easedFraction) before being turned into an
 * angle, rather than used directly - since it's applied to the shared
 * angle, cos(eased)^2 + sin(eased)^2 is still identically 1 for any eased
 * value, so equal-power is unaffected regardless of how much easing is applied.
 */
export function equalPowerGain(fraction: number, isOutgoing: boolean, durationSeconds: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  const angle = easedFraction(clamped, durationSeconds) * (Math.PI / 2);
  return isOutgoing ? Math.cos(angle) : Math.sin(angle);
}

/**
 * Samples the curve at sampleCount+1 evenly-spaced points across [0,1] -
 * shared by both the real playback scheduling (SourceNode.rampGainCurve)
 * and the debug preview, so what's drawn matches what actually plays.
 */
export function sampleEqualPowerGainCurve(sampleCount: number, isOutgoing: boolean, durationSeconds: number): number[] {
  const curve: number[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    curve.push(equalPowerGain(i / sampleCount, isOutgoing, durationSeconds));
  }
  return curve;
}
