import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../library-store/types';
import { parseM3u8 } from '../playlist/m3u8';
import { addTracksToPlaylist, PlaylistFileNotFoundError } from './addTracksToPlaylist';

/** Same shape as findUnplaylistedTracks.test.ts's identical fake - an in-memory FileAccess over a flat { relativePath: content } map, plus recorded writes. */
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

describe('addTracksToPlaylist', () => {
  it('appends tracks to the end, relative to the playlist file own location', async () => {
    const fileAccess = new FakeFileAccess({ 'Mixes/Party.m3u8': ['#EXTM3U', 'Track A.mp3'].join('\n') });
    const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Mixes/Party.m3u8', name: 'Party', trackFileIds: ['Mixes/Track A.mp3'] };

    await addTracksToPlaylist(fileAccess, 'root-1', playlist, [track('Mixes/Track B.mp3'), track('Loose/Track C.mp3')]);

    const written = fileAccess.written.get('Mixes/Party.m3u8')!;
    expect(parseM3u8(written).map((e) => e.rawPath)).toEqual(['Track A.mp3', 'Track B.mp3', '../Loose/Track C.mp3']);
  });

  it('inserts tracks at the start when position is "start"', async () => {
    const fileAccess = new FakeFileAccess({ 'Party.m3u8': ['#EXTM3U', 'Track A.mp3'].join('\n') });
    const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Party.m3u8', name: 'Party', trackFileIds: ['Track A.mp3'] };

    await addTracksToPlaylist(fileAccess, 'root-1', playlist, [track('Track B.mp3')], 'start');

    const written = fileAccess.written.get('Party.m3u8')!;
    expect(parseM3u8(written).map((e) => e.rawPath)).toEqual(['Track B.mp3', 'Track A.mp3']);
  });

  it('is a no-op for an empty track list', async () => {
    const fileAccess = new FakeFileAccess({ 'Party.m3u8': ['#EXTM3U', 'Track A.mp3'].join('\n') });
    const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Party.m3u8', name: 'Party', trackFileIds: ['Track A.mp3'] };

    await addTracksToPlaylist(fileAccess, 'root-1', playlist, []);

    expect(fileAccess.written.size).toBe(0);
  });

  it('throws PlaylistFileNotFoundError when the playlist fileId no longer matches any .m3u8 under the root', async () => {
    const fileAccess = new FakeFileAccess({ 'Track A.mp3': 'fake-audio' });
    const playlist: PlaylistRecord = { id: 'p1', rootId: 'root-1', fileId: 'Gone.m3u8', name: 'Gone', trackFileIds: [] };

    await expect(addTracksToPlaylist(fileAccess, 'root-1', playlist, [track('Track A.mp3')])).rejects.toThrow(PlaylistFileNotFoundError);
  });
});
