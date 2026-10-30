import { describe, expect, it } from 'vitest';
import { moveWithin } from './reorder';

describe('moveWithin', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  it('moves a track before or after an anchor', () => {
    expect(moveWithin(ids, ['a'], 'd', 'after')).toEqual(['b', 'c', 'd', 'a', 'e']);
    expect(moveWithin(ids, ['e'], 'b', 'before')).toEqual(['a', 'e', 'b', 'c', 'd']);
  });
  it('keeps several moved tracks together, in the order given', () => {
    expect(moveWithin(ids, ['d', 'b'], 'e', 'after')).toEqual(['a', 'c', 'e', 'd', 'b']);
  });
  it('gives nothing when the anchor is one of the moving tracks or unknown', () => {
    expect(moveWithin(ids, ['a', 'b'], 'b', 'after')).toBeNull();
    expect(moveWithin(ids, ['a'], 'zzz', 'before')).toBeNull();
  });
  it('does not change the original list', () => {
    const copy = [...ids];
    moveWithin(ids, ['a'], 'c', 'after');
    expect(ids).toEqual(copy);
  });
});
