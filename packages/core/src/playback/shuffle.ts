/**
 * Fisher-Yates shuffle. Returns a new array (never mutates the input) so
 * callers can freely hold onto the original order alongside the shuffled
 * one. `random` is injectable so tests can assert an exact permutation
 * instead of just "still a permutation".
 */
export function fisherYatesShuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }
  return result;
}
