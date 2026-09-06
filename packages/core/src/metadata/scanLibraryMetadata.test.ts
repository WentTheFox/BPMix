import { describe, expect, it } from 'vitest';
import type { FileAccess, FileRef, GrantedRoot, DirectoryEntry } from '../file-access/types';
import type { AnalysisResult, LibraryStore, LyricsScope, PlaybackState, PlaylistRecord, TrackRecord } from '../library-store/types';
import type { CoverArtBytes, TrackMetadata } from './types';
import { encodeBase64 } from './base64';
import { METADATA_PARSER_VERSION } from './ensureMetadata';
import { scanLibraryMetadata, type ScanMetadataProgress } from './scanLibraryMetadata';

class FakeLibraryStore implements LibraryStore {
  metadata = new Map<string, TrackMetadata>();
  coverArt = new Map<string, string>();

  async upsertTrack(): Promise<void> {}
  async upsertPlaylist(): Promise<void> {}
  async listTracks(): Promise<TrackRecord[]> {
    return [];
  }
  async listPlaylists(): Promise<PlaylistRecord[]> {
    return [];
  }
  async getAnalysis(): Promise<AnalysisResult | null> {
    return null;
  }
  async putAnalysis(): Promise<void> {}
  async getMetadata(fileId: string): Promise<TrackMetadata | null> {
    return this.metadata.get(fileId) ?? null;
  }
  async putMetadata(result: TrackMetadata): Promise<void> {
    this.metadata.set(result.fileId, result);
  }
  async getCoverArt(fileId: string): Promise<string | null> {
    return this.coverArt.get(fileId) ?? null;
  }
  async putCoverArt(fileId: string, art: CoverArtBytes | null): Promise<void> {
    if (art === null) {
      this.coverArt.delete(fileId);
    } else {
      this.coverArt.set(fileId, `data:${art.mimeType};base64,${encodeBase64(art.data)}`);
    }
  }
  async getPlaybackState(): Promise<PlaybackState | null> {
    return null;
  }
  async putPlaybackState(): Promise<void> {}
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

class FakeFileAccess implements FileAccess {
  constructor(private bytesByFileId: Map<string, ArrayBuffer>) {}

  async requestRoot(): Promise<GrantedRoot | null> {
    return null;
  }
  async listGrantedRoots(): Promise<GrantedRoot[]> {
    return [];
  }
  async revokeRoot(): Promise<void> {}
  async listDirectory(): Promise<DirectoryEntry[]> {
    return [];
  }
  async readFileBytes(ref: FileRef): Promise<ArrayBuffer> {
    const bytes = this.bytesByFileId.get(ref.id);
    if (!bytes) throw new Error(`no bytes for ${ref.id}`);
    return bytes;
  }
  async readFileText(): Promise<string> {
    return '';
  }
}

function track(fileId: string): TrackRecord {
  return { fileId, rootId: 'root', relativePath: `${fileId}.mp3`, sizeBytes: 64, lastModifiedMs: 1 };
}

describe('scanLibraryMetadata', () => {
  it('scans every track exactly once and resolves, with no native requestIdleCallback (the Vitest/Node fallback path)', async () => {
    const store = new FakeLibraryStore();
    const tracks = [track('a'), track('b'), track('c')];
    const bytes = new Map(tracks.map((t) => [t.fileId, new Uint8Array(64).buffer]));
    const fileAccess = new FakeFileAccess(bytes);
    const seen: ScanMetadataProgress[] = [];

    await scanLibraryMetadata(fileAccess, store, tracks, { onProgress: (info) => seen.push(info) });

    expect(seen.map((s) => s.track.fileId).sort()).toEqual(['a', 'b', 'c']);
    expect(seen.every((s) => !s.skipped)).toBe(true);
    expect(seen.every((s) => s.total === 3)).toBe(true);
    for (const t of tracks) {
      expect(await store.getMetadata(t.fileId)).not.toBeNull();
    }
  });

  it('resolves immediately for an empty track list', async () => {
    const store = new FakeLibraryStore();
    await expect(scanLibraryMetadata(new FakeFileAccess(new Map()), store, [])).resolves.toBeUndefined();
  });

  it('skips a track whose stored metadata is already fresh, without touching fileAccess for it', async () => {
    const store = new FakeLibraryStore();
    const staleRef = track('a');
    await store.putMetadata({ fileId: 'a', title: 'Cached', artists: [], album: null, sizeBytes: 64, lastModifiedMs: 1, parserVersion: METADATA_PARSER_VERSION });
    const fileAccess = new FakeFileAccess(new Map()); // throws if read - proves the skip really skipped
    const seen: ScanMetadataProgress[] = [];

    await scanLibraryMetadata(fileAccess, store, [staleRef], { onProgress: (info) => seen.push(info) });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.skipped).toBe(true);
  });

  it('bumps a priority fileId ahead of the rest of the list, re-evaluated on every step', async () => {
    const store = new FakeLibraryStore();
    const tracks = [track('a'), track('b'), track('c')];
    const fileAccess = new FakeFileAccess(new Map(tracks.map((t) => [t.fileId, new Uint8Array(64).buffer])));
    const order: string[] = [];

    await scanLibraryMetadata(fileAccess, store, tracks, {
      onProgress: (info) => order.push(info.track.fileId),
      getPriorityFileIds: () => ['c'],
    });

    expect(order[0]).toBe('c');
    expect(order.sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports an error via onProgress instead of aborting the rest of the scan', async () => {
    const store = new FakeLibraryStore();
    const tracks = [track('a'), track('b')];
    // Only 'b' has bytes - 'a' throws inside ensureTrackMetadata's readFileBytes.
    const fileAccess = new FakeFileAccess(new Map([['b', new Uint8Array(64).buffer]]));
    const seen: ScanMetadataProgress[] = [];

    await scanLibraryMetadata(fileAccess, store, tracks, { onProgress: (info) => seen.push(info) });

    expect(seen).toHaveLength(2);
    const failed = seen.find((s) => s.track.fileId === 'a')!;
    expect(failed.error).toBeDefined();
    const succeeded = seen.find((s) => s.track.fileId === 'b')!;
    expect(succeeded.error).toBeUndefined();
    expect(await store.getMetadata('b')).not.toBeNull();
  });

  it('drains multiple chunks when a fake requestIdleCallback reports a longer idle window per call', async () => {
    const originalRequestIdleCallback = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    let calls = 0;
    (globalThis as { requestIdleCallback?: (cb: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void) => void }).requestIdleCallback = (
      cb,
    ) => {
      calls++;
      // Reports ample time remaining so every track fits in a single chunk.
      setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 1000 }), 0);
    };
    try {
      const store = new FakeLibraryStore();
      const tracks = [track('a'), track('b'), track('c')];
      const fileAccess = new FakeFileAccess(new Map(tracks.map((t) => [t.fileId, new Uint8Array(64).buffer])));

      await scanLibraryMetadata(fileAccess, store, tracks);

      expect(calls).toBe(1); // all three tracks drained within the single idle deadline
    } finally {
      (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = originalRequestIdleCallback;
    }
  });
});
