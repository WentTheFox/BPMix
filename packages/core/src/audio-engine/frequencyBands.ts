/**
 * Buckets a linear-frequency magnitude array (as from an AnalyserNode's
 * getByteFrequencyData - one 0-255 bin per equally-spaced frequency, DC at
 * index 0) into `bandCount` bands, log-spaced rather than evenly split -
 * frequency perception is logarithmic, so an even split would burn most of
 * the bands on largely-inaudible top-octave hiss while cramming all of the
 * musically-significant bass/mid content into the first band or two. Each
 * band's value is an RMS-style average (sqrt of the mean of squares, not a
 * flat mean) of its bin range - a plain peak pegs every band near the top
 * almost all the time (a higher band can span 100+ bins, and real music
 * almost always has at least one strongly-lit bin somewhere that wide -
 * confirmed on-device), while a flat mean under-weights the loud bins that
 * actually define how "hot" a band sounds. Squaring before averaging
 * biases it back toward the louder content in the range without simply
 * taking the single loudest bin. Returns bandCount values, each in [0,1].
 */
export function bandsFromByteFrequencyData(magnitudes: Uint8Array, bandCount: number): number[] {
  const binCount = magnitudes.length;
  const bands: number[] = [];
  for (let band = 0; band < bandCount; band++) {
    // log-spaced edges over bins [1, binCount) - bin 0 (DC) is excluded, it
    // carries no audible frequency content and would otherwise dominate the
    // lowest band.
    const startBin = Math.max(1, Math.floor(binCount ** (band / bandCount)));
    const endBin = Math.max(startBin + 1, Math.floor(binCount ** ((band + 1) / bandCount)));
    let sumSquares = 0;
    let count = 0;
    for (let i = startBin; i < Math.min(endBin, binCount); i++) {
      const value = magnitudes[i] ?? 0;
      sumSquares += value * value;
      count++;
    }
    bands.push(count > 0 ? Math.sqrt(sumSquares / count) / 255 : 0);
  }
  return bands;
}
