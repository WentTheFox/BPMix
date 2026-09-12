import { describe, expect, it } from 'vitest';
import { formatM3u8, parseM3u8, resolveM3u8EntryPath } from './m3u8';

describe('parseM3u8', () => {
  it('parses EXTINF duration and title alongside the path', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:215,Artist - Track One',
      'Track One.mp3',
      '#EXTINF:-1,Artist - Track Two',
      'subdir/Track Two.mp3',
    ].join('\n');

    expect(parseM3u8(text)).toEqual([
      { rawPath: 'Track One.mp3', durationSeconds: 215, title: 'Artist - Track One' },
      { rawPath: 'subdir/Track Two.mp3', durationSeconds: -1, title: 'Artist - Track Two' },
    ]);
  });

  it('accepts bare paths with no EXTINF and ignores unknown directives', () => {
    const text = ['#EXTM3U', '#EXT-X-SOMETHING-VENDOR-SPECIFIC', 'plain.mp3', '', '  '].join('\n');

    expect(parseM3u8(text)).toEqual([{ rawPath: 'plain.mp3', durationSeconds: undefined, title: undefined }]);
  });

  it('handles CRLF line endings', () => {
    const text = '#EXTM3U\r\ntrack.mp3\r\n';
    expect(parseM3u8(text)).toEqual([{ rawPath: 'track.mp3', durationSeconds: undefined, title: undefined }]);
  });
});

describe('resolveM3u8EntryPath', () => {
  it('resolves a relative entry against the playlist directory', () => {
    expect(resolveM3u8EntryPath('Playlists/Mix.m3u8', 'Track.mp3')).toBe('Playlists/Track.mp3');
  });

  it('resolves entries that reference sibling directories via ..', () => {
    expect(resolveM3u8EntryPath('Playlists/Mix.m3u8', '../Artist/Album/Track.mp3')).toBe('Artist/Album/Track.mp3');
  });

  it('normalizes backslashes from Windows-authored playlists', () => {
    expect(resolveM3u8EntryPath('Playlists\\Mix.m3u8', 'Artist\\Track.mp3')).toBe('Playlists/Artist/Track.mp3');
  });

  it('falls back to root-relative for absolute-looking entries', () => {
    expect(resolveM3u8EntryPath('Playlists/Mix.m3u8', '/Music/Artist/Track.mp3')).toBe('Music/Artist/Track.mp3');
    expect(resolveM3u8EntryPath('Playlists/Mix.m3u8', 'C:/Music/Artist/Track.mp3')).toBe('Music/Artist/Track.mp3');
  });

  it('resolves a playlist at the root with no directory prefix', () => {
    expect(resolveM3u8EntryPath('Mix.m3u8', 'Track.mp3')).toBe('Track.mp3');
  });
});

describe('formatM3u8', () => {
  it('writes a plain path-per-line entry with no EXTINF when neither field is given', () => {
    expect(formatM3u8([{ rawPath: 'Track.mp3' }])).toBe('#EXTM3U\nTrack.mp3\n');
  });

  it('writes an EXTINF directive when duration/title are given', () => {
    expect(formatM3u8([{ rawPath: 'Track One.mp3', durationSeconds: 215, title: 'Artist - Track One' }])).toBe(
      '#EXTM3U\n#EXTINF:215,Artist - Track One\nTrack One.mp3\n',
    );
  });

  it('roundtrips through parseM3u8', () => {
    const entries = [
      { rawPath: 'Track One.mp3', durationSeconds: 215, title: 'Artist - Track One' },
      { rawPath: 'Track Two.mp3' },
    ];
    expect(parseM3u8(formatM3u8(entries))).toEqual([
      { rawPath: 'Track One.mp3', durationSeconds: 215, title: 'Artist - Track One' },
      { rawPath: 'Track Two.mp3', durationSeconds: undefined, title: undefined },
    ]);
  });
});
