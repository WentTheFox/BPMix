import { describe, expect, it } from 'vitest';
import type { ParsedLyrics } from './lrc';
import { matchTranslationLines } from './matchTranslationLines';

function lyrics(synced: boolean, lines: { timeSeconds: number | null; text: string }[]): ParsedLyrics {
  return { synced, tags: {}, lines };
}

describe('matchTranslationLines', () => {
  it('attaches the closest translation line within tolerance', () => {
    const native = lyrics(true, [
      { timeSeconds: 10, text: 'native one' },
      { timeSeconds: 20, text: 'native two' },
    ]);
    const translation = lyrics(true, [
      { timeSeconds: 10.4, text: 'translated one' },
      { timeSeconds: 20.9, text: 'translated two' },
    ]);
    expect(matchTranslationLines(native, translation).lines).toEqual([
      { timeSeconds: 10, text: 'native one', translation: 'translated one' },
      { timeSeconds: 20, text: 'native two', translation: 'translated two' },
    ]);
  });

  it('leaves translation null when nothing is within tolerance', () => {
    const native = lyrics(true, [{ timeSeconds: 10, text: 'native' }]);
    const translation = lyrics(true, [{ timeSeconds: 15, text: 'too far' }]);
    expect(matchTranslationLines(native, translation).lines).toEqual([{ timeSeconds: 10, text: 'native', translation: null }]);
  });

  it('picks the closest candidate when multiple are within tolerance', () => {
    // translation.lines ascending by timeSeconds, per parseLrc's contract for a synced file - the pointer walk assumes this.
    const native = lyrics(true, [{ timeSeconds: 10, text: 'native' }]);
    const translation = lyrics(true, [
      { timeSeconds: 10.2, text: 'closer' },
      { timeSeconds: 10.9, text: 'farther' },
    ]);
    expect(matchTranslationLines(native, translation).lines[0]!.translation).toBe('closer');
  });

  it('never assigns the same translation line to two different native lines (regression)', () => {
    // Two native lines close together (1.3s apart - both individually
    // within TRANSLATION_MATCH_TOLERANCE_SECONDS of the one translation
    // line sitting between them) must not both claim it - confirmed
    // on-device: this exact shape duplicated one translated line under
    // two different native lyric lines.
    const native = lyrics(true, [
      { timeSeconds: 14.63, text: 'native A' },
      { timeSeconds: 15.96, text: 'native B' },
    ]);
    const translation = lyrics(true, [{ timeSeconds: 15.2, text: 'shared candidate' }]);
    const result = matchTranslationLines(native, translation).lines;
    // Whichever native line is objectively closer (native B: delta 0.76 vs native A: delta 0.57 - A is closer) gets it; the other gets null, never a duplicate of the same text.
    expect(result[0]!.translation).toBe('shared candidate');
    expect(result[1]!.translation).toBeNull();
  });

  it('never lets a later native line steal an earlier native line\'s rightful match (regression)', () => {
    // "native A" (its own translation sits 0.84s away) is followed 1.15s
    // later by "native B", whose own correct translation is deliberately
    // out of tolerance (1.59s away) - but that same translation line is
    // only 0.09s from native B, objectively closer to B than A's
    // translation is to A. A plain "globally closest pair wins" greedy
    // assignment picks the (B, translation-for-A) pair first (smallest
    // delta overall) and leaves A with nothing - confirmed on-device via a
    // hand-built test file ("Már készül az éjjel" lost its correct
    // translation to the next line, "Nyakig ér a szívem", this way). The
    // sequential two-pointer walk must instead give A first claim on
    // whatever's in its own window, in native-line order, before B ever
    // gets a look at it.
    const native = lyrics(true, [
      { timeSeconds: 18.66, text: 'native A' },
      { timeSeconds: 21.49, text: 'native B' },
    ]);
    const translation = lyrics(true, [{ timeSeconds: 19.5, text: "A's translation" }]);
    const result = matchTranslationLines(native, translation).lines;
    expect(result[0]!.translation).toBe("A's translation");
    expect(result[1]!.translation).toBeNull();
  });

  it('gives a later native line the next-closest translation once an earlier one claims the nearest', () => {
    const native = lyrics(true, [
      { timeSeconds: 10, text: 'native one' },
      { timeSeconds: 10.3, text: 'native two' },
    ]);
    const translation = lyrics(true, [
      { timeSeconds: 10.05, text: 'closest to one' },
      { timeSeconds: 10.9, text: 'next closest' },
    ]);
    const result = matchTranslationLines(native, translation).lines;
    expect(result[0]!.translation).toBe('closest to one');
    expect(result[1]!.translation).toBe('next closest');
  });

  it('returns native unchanged when the translation is unsynced', () => {
    const native = lyrics(true, [{ timeSeconds: 10, text: 'native' }]);
    const translation = lyrics(false, [{ timeSeconds: null, text: 'plain translation' }]);
    expect(matchTranslationLines(native, translation)).toBe(native);
  });

  it('leaves an unsynced native line (timeSeconds null) untouched', () => {
    const native = lyrics(false, [{ timeSeconds: null, text: 'native plain' }]);
    const translation = lyrics(true, [{ timeSeconds: 0, text: 'translated' }]);
    expect(matchTranslationLines(native, translation).lines).toEqual([{ timeSeconds: null, text: 'native plain' }]);
  });
});
