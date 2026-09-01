import { describe, expect, it } from 'vitest';
import { fisherYatesShuffle } from './shuffle';

describe('fisherYatesShuffle', () => {
  it('does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    fisherYatesShuffle(input, () => 0);
    expect(input).toEqual(copy);
  });

  it('returns a permutation containing every element exactly once', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const shuffled = fisherYatesShuffle(input);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });

  it('produces a deterministic result for a fixed random source', () => {
    // random() always returning 0 means every swap targets index 0.
    const result = fisherYatesShuffle([1, 2, 3, 4], () => 0);
    expect(result).toEqual([2, 3, 4, 1]);
  });

  it('handles empty and single-element arrays', () => {
    expect(fisherYatesShuffle([])).toEqual([]);
    expect(fisherYatesShuffle([1])).toEqual([1]);
  });
});
