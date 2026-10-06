import { describe, expect, it } from 'vitest';
import type { AnalysisResult, LibraryStore, LyricsScope, PlaybackState, PlaylistRecord, TrackRecord } from '../library-store/types';
import type { TrackMetadata } from '../metadata/types';
import { pruneOrphanedRootData } from './pruneOrphanedRootData';

/** Same shape as deleteRootLibraryData.test.ts's identical fake. */
class FakeLibraryStore implements LibraryStore {
  tracks = new Map<string, TrackRecord>();
  playlists = new Map<string, PlaylistRecord>();
  analysis = new Map<string, AnalysisResult>();
  playbackState: PlaybackState | null = null;

  async upsertTrack(track: TrackRecord): Promise<void> {
    this.tracks.set(track.fileId, track);
  }
  async deleteTrack(fileId: string): Promise<void> {
    this.tracks.delete(fileId);
  }
  async upsertPlaylist(playlist: PlaylistRecord): Promise<void> {
    this.playlists.set(playlist.id, playlist);
  }
  async deletePlaylist(id: string): Promise<void> {
    this.playlists.delete(id);
  }
  async listTracks(rootId: string): Promise<TrackRecord[]> {
    return [...this.tracks.values()].filter((t) => t.rootId === rootId);
  }
  async listPlaylists(rootId: string): Promise<PlaylistRecord[]> {
    return [...this.playlists.values()].filter((p) => p.rootId === rootId);
  }
  async listAllTracks(): Promise<TrackRecord[]> {
    return [...this.tracks.values()];
  }
  async listAllPlaylists(): Promise<PlaylistRecord[]> {
    return [...this.playlists.values()];
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

function track(fileId: string, rootId: string): TrackRecord {
  return { fileId, rootId, relativePath: fileId, sizeBytes: 0, lastModifiedMs: 0 };
}

describe('pruneOrphanedRootData', () => {
  it('deletes tracks/playlists for a rootId no longer in the granted-roots list', async () => {
    const store = new FakeLibraryStore();
    await store.upsertTrack(track('a.mp3', 'root-1'));
    await store.upsertTrack(track('b.mp3', 'root-2'));
    await store.upsertPlaylist({ id: 'p1', rootId: 'root-1', fileId: 'Mix.m3u8', name: 'Mix', trackFileIds: ['a.mp3'] });

    const pruned = await pruneOrphanedRootData(store, ['root-2']);

    expect(pruned).toEqual(['root-1']);
    expect(await store.listTracks('root-1')).toEqual([]);
    expect(await store.listPlaylists('root-1')).toEqual([]);
    expect(await store.listTracks('root-2')).toEqual([track('b.mp3', 'root-2')]);
  });

  it('leaves every root alone when all of them are still granted', async () => {
    const store = new FakeLibraryStore();
    await store.upsertTrack(track('a.mp3', 'root-1'));

    const pruned = await pruneOrphanedRootData(store, ['root-1']);

    expect(pruned).toEqual([]);
    expect(await store.listTracks('root-1')).toEqual([track('a.mp3', 'root-1')]);
  });

  it('prunes a root known only via a playlist row, with no track rows of its own', async () => {
    const store = new FakeLibraryStore();
    await store.upsertPlaylist({ id: 'p1', rootId: 'root-1', fileId: 'Mix.m3u8', name: 'Mix', trackFileIds: [] });

    const pruned = await pruneOrphanedRootData(store, []);

    expect(pruned).toEqual(['root-1']);
    expect(await store.listPlaylists('root-1')).toEqual([]);
  });

  it('is a no-op against an empty store', async () => {
    const store = new FakeLibraryStore();
    await expect(pruneOrphanedRootData(store, [])).resolves.toEqual([]);
  });
});
