/**
 * Reference loudness target, in dBFS (RMS). Every track's normalizationGain
 * is computed relative to this single fixed target - not a "correct" value
 * in any broadcast-standard sense, just a consistent reference point so a
 * quiet and a loud track in the library end up sounding similarly loud.
 */
const REFERENCE_LOUDNESS_DB = -18;

/** Clamp bounds (linear amplitude) so a near-silent or clipping-loud outlier track doesn't get an absurd gain. */
const MIN_GAIN = 0.25; // -12dB
const MAX_GAIN = 4; // +12dB

const SILENCE_FLOOR_DB = -80;

/** RMS loudness of a signal, in dBFS. -Infinity (clamped to SILENCE_FLOOR_DB) for true silence. */
export function measureLoudnessDb(samples: Float32Array): number {
  if (samples.length === 0) return SILENCE_FLOOR_DB;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms <= 0) return SILENCE_FLOOR_DB;
  return Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms));
}

/** Gain multiplier (linear amplitude) to bring a track measured at loudnessDb to the reference target. */
export function computeNormalizationGain(loudnessDb: number): number {
  const gainDb = REFERENCE_LOUDNESS_DB - loudnessDb;
  const gain = Math.pow(10, gainDb / 20);
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
}
