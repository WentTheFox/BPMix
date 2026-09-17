import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '../file-access/types';
import type { AnalysisResult, LibraryStore, LyricsScope, PlaybackState, PlaylistRecord, TrackRecord } from '../library-store/types';
import type { TrackMetadata } from '../metadata/types';
import { findUnplaylistedTracks } from './findUnplaylistedTracks';

/** Same shape as scan.test.ts's identical fake - an in-memory FileAccess over a flat { relativePath: content } map. */
class FakeFileAccess implements FileAccess {
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

  async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
    return new TextEncoder().encode(this.filesByPath[ref.relativePath]!).buffer as ArrayBuffer;
  }
  async readFileText(ref: FileRef): Promise<string> {
    return this.filesByPath[ref.relativePath]!;
  }
  async writeFileText(): Promise<void> {
    throw new Error('not used in this test');
  }
}

/** Same shape as scan.test.ts's identical fake. */
class FakeLibraryStore implements LibraryStore {
  tracks = new Map<string, TrackRecord>();
  playlists = new Map<string, PlaylistRecord>();
  analysis = new Map<string, AnalysisResult>();
  playbackState: PlaybackState | null = null;

  async upsertTrack(track: TrackRecord): Promise<void> {
    this.tracks.set(track.fileId, track);
  }
  async upsertPlaylist(playlist: PlaylistRecord): Promise<void> {
    this.playlists.set(playlist.id, playlist);
  }
  async listTracks(rootId: string): Promise<TrackRecord[]> {
    return [...this.tracks.values()].filter((t) => t.rootId === rootId);
  }
  async listPlaylists(rootId: string): Promise<PlaylistRecord[]> {
    return [...this.playlists.values()].filter((p) => p.rootId === rootId);
  }
  async getAnalysis(): Promise<AnalysisResult | null> {
    return null;
  }
  async putAnalysis(): Promise<void> {}
  async getMetadata(): Promise<TrackMetadata | null> {
    return null;
  }
  async putMetadata(): Promise<void> {}
  async getCoverArt(): Promise<string | null> {
    return null;
  }
  async putCoverArt(): Promise<void> {}
  async getPlaybackState(): Promise<PlaybackState | null> {
    return this.playbackState;
  }
  async putPlaybackState(state: PlaybackState): Promise<void> {
    this.playbackState = state;
  }
  async getLyricsScopes(): Promise<LyricsScope[]> {
    return [];
  }
  async addLyricsScope(): Promise<void> {}
  async removeLyricsScope(): Promise<void> {}
  async getLyricsAssignment(): Promise<string | null> {
    return null;
  }
  async putLyricsAssignment(): Promise<void> {}
  async getSetting(): Promise<string | null> {
    return null;
  }
  async putSetting(): Promise<void> {}
}

describe('findUnplaylistedTracks', () => {
  it('finds a file never referenced by any playlist, and stores it as a real track', async () => {
    const fileAccess = new FakeFileAccess({
      'Party Mix.m3u8': ['#EXTM3U', 'Track A.mp3'].join('\n'),
      'Track A.mp3': 'fake-audio-a',
      'Loose Track.mp3': 'fake-audio-loose',
    });
    const store = new FakeLibraryStore();
    await store.upsertTrack({ fileId: 'Track A.mp3', rootId: 'root-1', relativePath: 'Track A.mp3', sizeBytes: 12, lastModifiedMs: 0 });
    await store.upsertPlaylist({ id: 'p1', rootId: 'root-1', fileId: 'Party Mix.m3u8', name: 'Party Mix', trackFileIds: ['Track A.mp3'] });

    const result = await findUnplaylistedTracks(fileAccess, store, 'root-1');

    expect(result.map((t) => t.fileId)).toEqual(['Loose Track.mp3']);
    // The newly-found file is now a real, persisted TrackRecord.
    expect((await store.listTracks('root-1')).map((t) => t.fileId).sort()).toEqual(['Loose Track.mp3', 'Track A.mp3']);
  });

  it('includes a track orphaned by a playlist edit, with no walk needed to find it', async () => {
    const fileAccess = new FakeFileAccess({ 'Track A.mp3': 'fake-audio-a' });
    const store = new FakeLibraryStore();
    await store.upsertTrack({ fileId: 'Track A.mp3', rootId: 'root-1', relativePath: 'Track A.mp3', sizeBytes: 12, lastModifiedMs: 0 });
    // No playlist references it - e.g. the playlist that used to was since edited/deleted.

    const result = await findUnplaylistedTracks(fileAccess, store, 'root-1');

    expect(result.map((t) => t.fileId)).toEqual(['Track A.mp3']);
  });

  it('excludes a track referenced by any playlist', async () => {
    const fileAccess = new FakeFileAccess({
      'Party Mix.m3u8': ['#EXTM3U', 'Track A.mp3'].join('\n'),
      'Track A.mp3': 'fake-audio-a',
    });
    const store = new FakeLibraryStore();
    await store.upsertPlaylist({ id: 'p1', rootId: 'root-1', fileId: 'Party Mix.m3u8', name: 'Party Mix', trackFileIds: ['Track A.mp3'] });

    const result = await findUnplaylistedTracks(fileAccess, store, 'root-1');

    expect(result).toEqual([]);
  });

  it('excludes a missing (unresolved-placeholder) track even if unreferenced', async () => {
    const fileAccess = new FakeFileAccess({});
    const store = new FakeLibraryStore();
    await store.upsertTrack({
      fileId: 'ghost',
      rootId: 'root-1',
      relativePath: 'Ghost Track.mp3',
      sizeBytes: 0,
      lastModifiedMs: 0,
      missing: true,
    });

    const result = await findUnplaylistedTracks(fileAccess, store, 'root-1');

    expect(result).toEqual([]);
  });

  it('does not re-discover (or duplicate-upsert) a file that is already a known track', async () => {
    const fileAccess = new FakeFileAccess({ 'Track A.mp3': 'fake-audio-a' });
    const store = new FakeLibraryStore();
    await store.upsertTrack({ fileId: 'Track A.mp3', rootId: 'root-1', relativePath: 'Track A.mp3', sizeBytes: 999, lastModifiedMs: 42 });

    await findUnplaylistedTracks(fileAccess, store, 'root-1');

    // Untouched - not re-derived from the walked FileRef (which would report sizeBytes/lastModifiedMs from the fake file content instead).
    expect(store.tracks.get('Track A.mp3')).toEqual({
      fileId: 'Track A.mp3',
      rootId: 'root-1',
      relativePath: 'Track A.mp3',
      sizeBytes: 999,
      lastModifiedMs: 42,
    });
  });

  it('ignores non-audio files entirely', async () => {
    const fileAccess = new FakeFileAccess({ 'readme.txt': 'not audio', 'cover.jpg': 'not audio either' });
    const store = new FakeLibraryStore();

    const result = await findUnplaylistedTracks(fileAccess, store, 'root-1');

    expect(result).toEqual([]);
    expect(await store.listTracks('root-1')).toEqual([]);
  });
});
