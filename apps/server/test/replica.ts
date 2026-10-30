import type { PlaybackStateDto, PlaylistDto, SyncChangeDto, SyncChangesResponseDto, SyncSnapshotResponseDto, TrackDto, UserPlaylistDto, UserSettingDto } from '@bpmix/api';
import type { TestClient } from './testClient.js';

/** What a client holds: the entities it has been told about, and its place in the feed. */
export class LocalReplica {
  tracks = new Map<string, TrackDto>();
  playlists = new Map<string, PlaylistDto>();
  userPlaylists = new Map<string, UserPlaylistDto>();
  playbackStates = new Map<string, PlaybackStateDto>();
  settings = new Map<string, UserSettingDto>();
  cursor: string | null = null;
  roots: { id: string }[] = [];
  requests = 0;

  private static put<T>(map: Map<string, T>, id: string, value: T | null): void {
    if (value) map.set(id, value);
    else map.delete(id);
  }

  apply(changes: SyncChangeDto[]): void {
    for (const change of changes) {
      switch (change.entity) {
        case 'track':
          LocalReplica.put(this.tracks, change.id, change.track);
          break;
        case 'playlist':
          LocalReplica.put(this.playlists, change.id, change.playlist);
          break;
        case 'userPlaylist':
          LocalReplica.put(this.userPlaylists, change.id, change.userPlaylist);
          break;
        case 'playbackState':
          LocalReplica.put(this.playbackStates, change.id, change.playbackState);
          break;
        case 'setting':
          LocalReplica.put(this.settings, change.id, change.setting);
          break;
      }
    }
  }

  private clear(): void {
    this.tracks.clear();
    this.playlists.clear();
    this.userPlaylists.clear();
    this.playbackStates.clear();
    this.settings.clear();
  }

  /** The first sync, or after a 410: walk the snapshot, then continue from where it started. */
  async snapshot(client: TestClient, limit = 500): Promise<void> {
    this.clear();
    let after: string | undefined;
    let startedAt: string | undefined;
    do {
      const page = await client.json<SyncSnapshotResponseDto>(`/api/v1/sync/snapshot?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      this.requests++;
      startedAt ??= page.cursor;
      this.apply(page.entities);
      this.roots = page.roots;
      after = page.next ?? undefined;
    } while (after);
    this.cursor = startedAt!;
  }

  /** One check-in: pull until caught up. Falls back to a snapshot if the server says the position is stale. */
  async checkIn(client: TestClient, limit = 500): Promise<void> {
    if (this.cursor === null) return this.snapshot(client, limit);
    for (;;) {
      const res = await client.fetch(`/api/v1/sync/changes?since=${this.cursor}&limit=${limit}`);
      this.requests++;
      if (res.status === 410) return this.snapshot(client, limit);
      const page = (await res.json()) as SyncChangesResponseDto;
      this.apply(page.changes);
      this.cursor = page.cursor;
      this.roots = page.roots;
      if (!page.hasMore) return;
    }
  }
}

export const sorted = <T>(map: Map<string, T>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
