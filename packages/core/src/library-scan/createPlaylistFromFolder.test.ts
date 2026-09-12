import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '../file-access/types';
import { parseM3u8 } from '../playlist/m3u8';
import { sortPlaylistCandidates, writePlaylistFile, type PlaylistCandidateTrack } from './createPlaylistFromFolder';

/** In-memory FileAccess that also records writes, for testing writePlaylistFile without a real filesystem. */
class FakeWritableFileAccess implements FileAccess {
  written = new Map<string, string>();

  async requestRoot(): Promise<GrantedRoot | null> {
    throw new Error('not used in this test');
  }
  async listGrantedRoots(): Promise<GrantedRoot[]> {
    return [];
  }
  async revokeRoot(): Promise<void> {}
  async listDirectory(): Promise<DirectoryEntry[]> {
    return [];
  }
  async readFileBytes(): Promise<ArrayBuffer> {
    throw new Error('not used in this test');
  }
  async readFileText(): Promise<string> {
    throw new Error('not used in this test');
  }
  async writeFileText(_rootId: string, relativePath: string, contents: string): Promise<void> {
    this.written.set(relativePath, contents);
  }
}

function track(relativePath: string, overrides: Partial<PlaylistCandidateTrack> = {}): PlaylistCandidateTrack {
  const name = relativePath.split('/').pop()!;
  return {
    file: { id: relativePath, name, relativePath, sizeBytes: 0, lastModifiedMs: 0 },
    title: null,
    artist: null,
    album: null,
    ...overrides,
  };
}

describe('sortPlaylistCandidates', () => {
  it('sorts by title, falling back to filename when a track has no title tag', () => {
    const tracks = [track('c.mp3', { title: 'Charlie' }), track('a.mp3', { title: 'Alpha' }), track('b.mp3')];
    const sorted = sortPlaylistCandidates(tracks, 'title', 'asc');
    expect(sorted.map((t) => t.file.relativePath)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
  });

  it('reverses order for desc', () => {
    const tracks = [track('a.mp3', { title: 'Alpha' }), track('b.mp3', { title: 'Beta' })];
    const sorted = sortPlaylistCandidates(tracks, 'title', 'desc');
    expect(sorted.map((t) => t.file.relativePath)).toEqual(['b.mp3', 'a.mp3']);
  });

  it('sorts by dateCreated using lastModifiedMs', () => {
    const tracks = [
      { ...track('newer.mp3'), file: { ...track('newer.mp3').file, lastModifiedMs: 200 } },
      { ...track('older.mp3'), file: { ...track('older.mp3').file, lastModifiedMs: 100 } },
    ];
    const sorted = sortPlaylistCandidates(tracks, 'dateCreated', 'asc');
    expect(sorted.map((t) => t.file.relativePath)).toEqual(['older.mp3', 'newer.mp3']);
  });

  it('sorts by artist and album, with untagged tracks sorting first (empty string)', () => {
    const tracks = [track('untagged.mp3'), track('withArtist.mp3', { artist: 'Zeta' })];
    const sorted = sortPlaylistCandidates(tracks, 'artist', 'asc');
    expect(sorted.map((t) => t.file.relativePath)).toEqual(['untagged.mp3', 'withArtist.mp3']);
  });

  it('does not mutate the input array', () => {
    const tracks = [track('b.mp3', { title: 'Beta' }), track('a.mp3', { title: 'Alpha' })];
    sortPlaylistCandidates(tracks, 'title', 'asc');
    expect(tracks.map((t) => t.file.relativePath)).toEqual(['b.mp3', 'a.mp3']);
  });
});

describe('writePlaylistFile', () => {
  it('writes an m3u8 with paths relative to the folder, for a folder at the root', async () => {
    const fileAccess = new FakeWritableFileAccess();
    const tracks = [track('Track A.mp3'), track('Sub/Track B.mp3')];

    const relativePath = await writePlaylistFile(fileAccess, 'root-1', '', 'My Mix', tracks);

    expect(relativePath).toBe('My Mix.m3u8');
    const written = fileAccess.written.get('My Mix.m3u8')!;
    expect(parseM3u8(written).map((e) => e.rawPath)).toEqual(['Track A.mp3', 'Sub/Track B.mp3']);
  });

  it('writes an m3u8 into a nested folder, stripping that folder prefix from each track path', async () => {
    const fileAccess = new FakeWritableFileAccess();
    const tracks = [track('Music/Album/Track A.mp3'), track('Music/Album/Disc2/Track B.mp3')];

    const relativePath = await writePlaylistFile(fileAccess, 'root-1', 'Music/Album', 'Album Mix', tracks);

    expect(relativePath).toBe('Music/Album/Album Mix.m3u8');
    const written = fileAccess.written.get('Music/Album/Album Mix.m3u8')!;
    expect(parseM3u8(written).map((e) => e.rawPath)).toEqual(['Track A.mp3', 'Disc2/Track B.mp3']);
  });

  it('sanitizes illegal filename characters out of the playlist name', async () => {
    const fileAccess = new FakeWritableFileAccess();

    const relativePath = await writePlaylistFile(fileAccess, 'root-1', '', 'Weekend: Party/Mix?', [track('Track.mp3')]);

    expect(relativePath).toBe('Weekend_ Party_Mix_.m3u8');
  });
});
