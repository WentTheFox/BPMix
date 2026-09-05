import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '../file-access/types';
import type {
  AnalysisResult,
  LibraryStore,
  LyricsScope,
  PlaybackState,
  PlaylistRecord,
  TrackRecord,
} from '../library-store/types';
import type { TrackMetadata } from '../metadata/types';
import { scanRoot } from './scan';

/** In-memory FileAccess over a flat { relativePath: content } map, for testing the walker/scanner. */
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
        entries.push({
          type: 'file',
          name: child,
          relativePath: childRelativePath,
          file: this.toFileRef(childRelativePath),
        });
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
}

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
  async getAnalysis(fileId: string): Promise<AnalysisResult | null> {
    return this.analysis.get(fileId) ?? null;
  }
  async putAnalysis(result: AnalysisResult): Promise<void> {
    this.analysis.set(result.fileId, result);
  }
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
}

describe('scanRoot', () => {
  it('resolves nested playlists against arbitrarily structured folders and upserts into the store', async () => {
    const fileAccess = new FakeFileAccess({
      'Playlists/Party Mix.m3u8': ['#EXTM3U', '#EXTINF:200,Track A', '../Artist A/Track A.mp3', 'Track B.mp3'].join(
        '\n',
      ),
      'Playlists/Track B.mp3': 'fake-audio-b',
      'Artist A/Track A.mp3': 'fake-audio-a',
    });
    const store = new FakeLibraryStore();

    const result = await scanRoot(fileAccess, store, 'root-1');

    expect(result.unresolvedEntries).toEqual([]);
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]!.name).toBe('Party Mix');
    expect(result.playlists[0]!.trackFileIds).toEqual(['Artist A/Track A.mp3', 'Playlists/Track B.mp3']);

    expect(store.tracks.size).toBe(2);
    expect(store.playlists.get('Playlists/Party Mix.m3u8')?.name).toBe('Party Mix');
  });

  it('surfaces playlist entries that do not resolve to an existing file instead of throwing', async () => {
    const fileAccess = new FakeFileAccess({
      'Mix.m3u8': ['Missing.mp3'].join('\n'),
    });
    const store = new FakeLibraryStore();

    const result = await scanRoot(fileAccess, store, 'root-1');

    expect(result.unresolvedEntries).toEqual([{ playlistRelativePath: 'Mix.m3u8', rawPath: 'Missing.mp3' }]);
    expect(result.playlists[0]!.trackFileIds).toEqual([]);
  });

  it('re-scanning an unchanged root is idempotent', async () => {
    const fileAccess = new FakeFileAccess({
      'Mix.m3u8': ['Track.mp3'].join('\n'),
      'Track.mp3': 'fake-audio',
    });
    const store = new FakeLibraryStore();

    await scanRoot(fileAccess, store, 'root-1');
    await scanRoot(fileAccess, store, 'root-1');

    expect(store.tracks.size).toBe(1);
    expect(store.playlists.size).toBe(1);
  });
});
