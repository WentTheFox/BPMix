import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../library-store/types';
import { parseM3u8 } from '../playlist/m3u8';
import { PlaylistFileNotFoundError } from './addTracksToPlaylist';
import { InvalidPlaylistMoveError, movePlaylistTracks, removePlaylistTracks } from './editPlaylistTracks';

/** Same shape as addTracksToPlaylist.test.ts's identical fake - an in-memory FileAccess over a flat { relativePath: content } map, plus recorded writes. */
class FakeFileAccess implements FileAccess {
  written = new Map<string, string>();

  constructor(private readonly filesByPath: Record<string, string>) {}

  async requestRoot(): Promise<GrantedRoot | null> {
    throw new Error('not used in this test');
  }
  async listGrantedRoots(): Promise<GrantedRoot[]> {
    return [];
  }
  async revokeRoot(): Promise<void> {}

  async listDirectory(_rootId: string, relativePath = ''): Promise<DirectoryEntry[]> {
    const prefix = relativePath === '' ? '' : `${relativePath}/`;
    const childrenSeen = new Set<string>();
    const entries: DirectoryEntry[] = [];

    for (const path of Object.keys(this.filesByPath)) {
      if (!path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      const [child, ...rest] = remainder.split('/');
      if (child === undefined || childrenSeen.has(child)) continue;
      childrenSeen.add(child);

      const childRelativePath = prefix + child;
      if (rest.length === 0) {
        entries.push({ type: 'file', name: child, relativePath: childRelativePath, file: this.toFileRef(childRelativePath) });
      } else {
        entries.push({ type: 'directory', name: child, relativePath: childRelativePath });
      }
    }
    return entries;
  }

  private toFileRef(relativePath: string): FileRef {
    return {
      id: relativePath,
      name: relativePath.split('/').pop()!,
      relativePath,
      sizeBytes: this.filesByPath[relativePath]!.length,
      lastModifiedMs: 0,
    };
  }

  async readFileBytes(): Promise<ArrayBuffer> {
    throw new Error('not used in this test');
  }
  async readFileText(ref: FileRef): Promise<string> {
    return this.filesByPath[ref.relativePath] ?? '';
  }
  async writeFileText(_rootId: string, relativePath: string, contents: string): Promise<void> {
    this.written.set(relativePath, contents);
    this.filesByPath[relativePath] = contents;
  }
}

function track(relativePath: string, fileId = relativePath): TrackRecord {
  return { fileId, rootId: 'root-1', relativePath, sizeBytes: 0, lastModifiedMs: 0 };
}

function makePlaylistAndTracks(order: string[]) {
  const fileAccess = new FakeFileAccess({ 'Party.m3u8': ['#EXTM3U', ...order].join('\n') });
  const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Party.m3u8', name: 'Party', trackFileIds: order };
  const tracksById = new Map(order.map((relativePath) => [relativePath, track(relativePath)]));
  return { fileAccess, playlist, tracksById };
}

describe('movePlaylistTracks', () => {
  it('moves a single track before an anchor', async () => {
    const { fileAccess, playlist, tracksById } = makePlaylistAndTracks(['A.mp3', 'B.mp3', 'C.mp3']);

    await movePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['C.mp3'], 'A.mp3', 'before');

    // The moved entry keeps its exact original rawPath text - a move only
    // repositions, it never rewrites the line itself.
    expect(parseM3u8(fileAccess.written.get('Party.m3u8')!).map((e) => e.rawPath)).toEqual(['C.mp3', 'A.mp3', 'B.mp3']);
  });

  it('moves a single track after an anchor', async () => {
    const { fileAccess, playlist, tracksById } = makePlaylistAndTracks(['A.mp3', 'B.mp3', 'C.mp3']);

    await movePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['A.mp3'], 'B.mp3', 'after');

    expect(parseM3u8(fileAccess.written.get('Party.m3u8')!).map((e) => e.rawPath)).toEqual(['B.mp3', 'A.mp3', 'C.mp3']);
  });

  it('moves multiple non-contiguous tracks together, preserving their original relative order', async () => {
    const { fileAccess, playlist, tracksById } = makePlaylistAndTracks(['A.mp3', 'B.mp3', 'C.mp3', 'D.mp3', 'E.mp3']);

    // Moving D then B (selection order) should still land as B, D (original relative order) after C.
    await movePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['D.mp3', 'B.mp3'], 'C.mp3', 'after');

    expect(parseM3u8(fileAccess.written.get('Party.m3u8')!).map((e) => e.rawPath)).toEqual(['A.mp3', 'C.mp3', 'B.mp3', 'D.mp3', 'E.mp3']);
  });

  it('throws InvalidPlaylistMoveError when moving zero tracks', async () => {
    const { fileAccess, playlist, tracksById } = makePlaylistAndTracks(['A.mp3', 'B.mp3']);

    await expect(movePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, [], 'A.mp3', 'before')).rejects.toThrow(InvalidPlaylistMoveError);
    expect(fileAccess.written.size).toBe(0);
  });

  it('throws InvalidPlaylistMoveError when the anchor is among the tracks being moved', async () => {
    const { fileAccess, playlist, tracksById } = makePlaylistAndTracks(['A.mp3', 'B.mp3']);

    await expect(movePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['A.mp3'], 'A.mp3', 'before')).rejects.toThrow(InvalidPlaylistMoveError);
    expect(fileAccess.written.size).toBe(0);
  });

  it('leaves an entry that does not resolve to a known track untouched, in place', async () => {
    const fileAccess = new FakeFileAccess({ 'Party.m3u8': ['#EXTM3U', 'A.mp3', 'Ghost.mp3', 'B.mp3'].join('\n') });
    const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Party.m3u8', name: 'Party', trackFileIds: ['A.mp3', 'B.mp3'] };
    const tracksById = new Map([
      ['A.mp3', track('A.mp3')],
      ['B.mp3', track('B.mp3')],
    ]);

    await movePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['B.mp3'], 'A.mp3', 'before');

    expect(parseM3u8(fileAccess.written.get('Party.m3u8')!).map((e) => e.rawPath)).toEqual(['B.mp3', 'A.mp3', 'Ghost.mp3']);
  });

  it('throws PlaylistFileNotFoundError when the playlist fileId no longer matches any .m3u8 under the root', async () => {
    const fileAccess = new FakeFileAccess({ 'A.mp3': 'fake-audio' });
    const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Gone.m3u8', name: 'Gone', trackFileIds: ['A.mp3'] };
    const tracksById = new Map([['A.mp3', track('A.mp3')]]);

    await expect(movePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['A.mp3'], 'B.mp3', 'before')).rejects.toThrow(PlaylistFileNotFoundError);
  });
});

describe('removePlaylistTracks', () => {
  it('removes the given tracks, preserving the order of the rest', async () => {
    const { fileAccess, playlist, tracksById } = makePlaylistAndTracks(['A.mp3', 'B.mp3', 'C.mp3']);

    await removePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['B.mp3']);

    expect(parseM3u8(fileAccess.written.get('Party.m3u8')!).map((e) => e.rawPath)).toEqual(['A.mp3', 'C.mp3']);
  });

  it('is a no-op for an empty removal list', async () => {
    const { fileAccess, playlist, tracksById } = makePlaylistAndTracks(['A.mp3', 'B.mp3']);

    await removePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, []);

    expect(fileAccess.written.size).toBe(0);
  });

  it('leaves an entry that does not resolve to a known track untouched', async () => {
    const fileAccess = new FakeFileAccess({ 'Party.m3u8': ['#EXTM3U', 'A.mp3', 'Ghost.mp3', 'B.mp3'].join('\n') });
    const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Party.m3u8', name: 'Party', trackFileIds: ['A.mp3', 'B.mp3'] };
    const tracksById = new Map([
      ['A.mp3', track('A.mp3')],
      ['B.mp3', track('B.mp3')],
    ]);

    await removePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['A.mp3']);

    expect(parseM3u8(fileAccess.written.get('Party.m3u8')!).map((e) => e.rawPath)).toEqual(['Ghost.mp3', 'B.mp3']);
  });

  it('throws PlaylistFileNotFoundError when the playlist fileId no longer matches any .m3u8 under the root', async () => {
    const fileAccess = new FakeFileAccess({ 'A.mp3': 'fake-audio' });
    const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Gone.m3u8', name: 'Gone', trackFileIds: ['A.mp3'] };
    const tracksById = new Map([['A.mp3', track('A.mp3')]]);

    await expect(removePlaylistTracks(fileAccess, 'root-1', playlist, tracksById, ['A.mp3'])).rejects.toThrow(PlaylistFileNotFoundError);
  });
});
