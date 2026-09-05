import { describe, expect, it } from 'vitest';
import { findAutoLyricsMatch, lyricsStem } from './matchLyrics';

describe('lyricsStem', () => {
  it('strips the extension and case-folds', () => {
    expect(lyricsStem('Track One.mp3')).toBe('track one');
    expect(lyricsStem('Track One.LRC')).toBe('track one');
  });

  it('leaves extension-less names alone', () => {
    expect(lyricsStem('Track One')).toBe('track one');
  });
});

describe('findAutoLyricsMatch', () => {
  it('matches a track to its same-stemmed lrc file', () => {
    const candidates = [
      { fileId: 'a', name: 'Track One.lrc' },
      { fileId: 'b', name: 'Track Two.lrc' },
    ];
    expect(findAutoLyricsMatch('Track One.flac', candidates)).toEqual({ fileId: 'a', name: 'Track One.lrc' });
  });

  it('is case-insensitive', () => {
    const candidates = [{ fileId: 'a', name: 'track one.lrc' }];
    expect(findAutoLyricsMatch('TRACK ONE.mp3', candidates)).toEqual({ fileId: 'a', name: 'track one.lrc' });
  });

  it('returns null when nothing matches', () => {
    const candidates = [{ fileId: 'a', name: 'Other Song.lrc' }];
    expect(findAutoLyricsMatch('Track One.mp3', candidates)).toBeNull();
  });

  it('returns null rather than guessing when multiple lrc files share the same stem', () => {
    const candidates = [
      { fileId: 'a', name: 'Track One.lrc' },
      { fileId: 'b', name: 'Track One.lrc' },
    ];
    expect(findAutoLyricsMatch('Track One.mp3', candidates)).toBeNull();
  });

  it('lets one lrc file match multiple different tracks (different quality/format files of the same song)', () => {
    const candidates = [{ fileId: 'a', name: 'Track One.lrc' }];
    expect(findAutoLyricsMatch('Track One.mp3', candidates)).toEqual({ fileId: 'a', name: 'Track One.lrc' });
    expect(findAutoLyricsMatch('Track One.flac', candidates)).toEqual({ fileId: 'a', name: 'Track One.lrc' });
  });
});
