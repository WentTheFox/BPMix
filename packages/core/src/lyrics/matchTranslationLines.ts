import type { ParsedLyrics } from './lrc';

/**
 * How far apart two lines' timestamps can be and still be considered "the
 * same line" across a native/translation pair. Native and translation come
 * from independently-sourced lrclib uploads (different transcribers), so
 * their timestamp grids can drift beyond simple rounding - not just
 * clock-skew-style small offsets - hence a full second rather than
 * something tighter.
 */
export const TRANSLATION_MATCH_TOLERANCE_SECONDS = 1;

/**
 * Attaches each native line's matching translation line (by timestamp,
 * within TRANSLATION_MATCH_TOLERANCE_SECONDS) as that line's `translation`
 * field - native lines are returned unchanged (translation left undefined)
 * if the translation itself isn't synced, since there's no reliable way to
 * align a plain-text translation to individual timed native lines.
 *
 * Matching is a sequential (monotonic) two-pointer walk over both lists in
 * their existing time order, NOT a free "closest match anywhere in the
 * list" search - both lists are the same song's lines in the same
 * chronological order, so once translation line J is used for native line
 * I, no native line after I is ever allowed to match a translation line
 * before J. Without that constraint (an earlier version of this function
 * picked each native line's own closest candidate independently, with no
 * memory of what earlier lines had already claimed), two DIFFERENT
 * problems showed up on-device with a hand-built test file:
 *   1. Two native lines close together in time could both independently
 *      find the same single translation line as their closest candidate,
 *      duplicating one translated line under two different native lines.
 *   2. Fixing #1 with a plain "globally closest pair wins, greedily"
 *      assignment (sorting every in-tolerance pair by delta and claiming
 *      greedily) still let a LATER native line's coincidentally-closer
 *      match steal a translation line out from under the EARLIER native
 *      line it actually belonged to - leaving the earlier line with no
 *      translation and the later line showing a semantically wrong one,
 *      even though both were legitimately within tolerance.
 * The two-pointer walk below fixes both: advancing the pointer forward
 * past whatever was just used means an earlier line's match is claimed
 * before a later line ever gets a chance to see (and steal) it.
 */
export function matchTranslationLines(native: ParsedLyrics, translation: ParsedLyrics): ParsedLyrics {
  if (!translation.synced) return native;

  // translation.lines is already sorted ascending by timeSeconds (parseLrc's
  // contract for a synced file) - the pointer walk below depends on that.
  const translationLines = translation.lines.filter((line) => line.timeSeconds !== null);

  const translationByNativeIndex = new Map<number, string>();
  let pointer = 0;
  for (let nativeIndex = 0; nativeIndex < native.lines.length; nativeIndex++) {
    const nativeTime = native.lines[nativeIndex]!.timeSeconds;
    if (nativeTime === null) continue;

    // Skip translation lines so far in the past they can't be a match for
    // this (or any later, since both lists only move forward) native line -
    // keeps each native line's search starting close to where it should,
    // rather than rescanning from the very start of the translation list
    // every time.
    while (pointer < translationLines.length - 1 && translationLines[pointer]!.timeSeconds! < nativeTime - TRANSLATION_MATCH_TOLERANCE_SECONDS) {
      pointer++;
    }

    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let i = pointer; i < translationLines.length; i++) {
      const candidateTime = translationLines[i]!.timeSeconds!;
      if (candidateTime > nativeTime + TRANSLATION_MATCH_TOLERANCE_SECONDS) break; // sorted ascending - nothing further out can be closer
      const delta = Math.abs(candidateTime - nativeTime);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }

    if (bestIndex !== -1) {
      translationByNativeIndex.set(nativeIndex, translationLines[bestIndex]!.text);
      pointer = bestIndex + 1; // never reconsider this (or any earlier) translation line for a later native line
    }
  }

  return {
    ...native,
    lines: native.lines.map((line, index) =>
      line.timeSeconds === null ? line : { ...line, translation: translationByNativeIndex.get(index) ?? null },
    ),
  };
}
