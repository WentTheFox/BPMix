/**
 * `ids` with `moving` taken out and re-inserted, in the order given, before or after `anchor`. Null if
 * the anchor isn't in the list once the moving tracks are removed (nothing sensible to do).
 */
export function moveWithin(ids: readonly string[], moving: readonly string[], anchor: string, position: 'before' | 'after'): string[] | null {
  const movingSet = new Set(moving);
  const remaining = ids.filter((id) => !movingSet.has(id));
  const anchorIndex = remaining.indexOf(anchor);
  if (anchorIndex === -1) return null;
  const insertAt = position === 'before' ? anchorIndex : anchorIndex + 1;
  return [...remaining.slice(0, insertAt), ...moving, ...remaining.slice(insertAt)];
}
