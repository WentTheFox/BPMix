/**
 * Equal-power crossfade gain at a given fraction [0,1] through the
 * transition. A straight linear fade (gain = fraction) spends much of its
 * duration sounding under-loud on the fading-in side (and abruptly loud
 * then long-tailed-quiet on the fading-out side), because human loudness
 * perception is roughly logarithmic, not linear in gain - a 20s linear
 * fade-in is still under 10% of its target gain 2 seconds in, which reads
 * as "not playing yet." The cos/sin pair here keeps outgoing^2 + incoming^2
 * constant across the whole transition, so combined perceived loudness
 * stays roughly level instead of dipping in the middle.
 */
export function equalPowerGain(fraction: number, isOutgoing: boolean): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  const angle = clamped * (Math.PI / 2);
  return isOutgoing ? Math.cos(angle) : Math.sin(angle);
}

/**
 * Samples the curve at sampleCount+1 evenly-spaced points across [0,1] -
 * shared by both the real playback scheduling (SourceNode.rampGainCurve)
 * and the debug preview, so what's drawn matches what actually plays.
 */
export function sampleEqualPowerGainCurve(sampleCount: number, isOutgoing: boolean): number[] {
  const curve: number[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    curve.push(equalPowerGain(i / sampleCount, isOutgoing));
  }
  return curve;
}
