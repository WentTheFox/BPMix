import { decodeTrackKey, type SyncChangeDto, type TrackDto } from '@bpmix/api';
import { ANALYSIS_ALGORITHM_VERSION } from '../analysis/analyzeTrack';
import type { LibraryStore, PlaylistRecord, TrackRecord } from '../library-store/types';
import { METADATA_PARSER_VERSION } from '../metadata/ensureMetadata';
import type { TrackMetadata } from '../metadata/types';

/** Local playlist ids for playlists the user built in the app (as opposed to a library m3u8, whose id is its file id). */
export const USER_PLAYLIST_ID_PREFIX = 'user:';

export interface ApplyContext {
  store: LibraryStore;
  /** Where playlists that don't belong to a root (the user's own) are filed, so the existing per-root library screens show them. */
  defaultRootId: () => string | null;
  now: () => number;
}

/** A key that doesn't decode is skipped rather than failing the whole sync. */
function fileIdOf(key: string): string | null {
  try {
    return decodeTrackKey(key);
  } catch {
    return null;
  }
}

/**
 * Turns the server's view of a track into what the rest of the app already reads. A track's tags,
 * duration and loudness arrive with it, so the app never reads a file or decodes audio just to
 * show a title: the records are written as if a local scan had produced them.
 */
export async function applyTrack(ctx: ApplyContext, fileId: string, dto: TrackDto): Promise<void> {
  const track: TrackRecord = {
    fileId,
    rootId: dto.rootId,
    relativePath: dto.relativePath,
    sizeBytes: dto.sizeBytes,
    lastModifiedMs: dto.lastModifiedMs,
    ...(dto.missing ? { missing: true } : {}),
  };
  await ctx.store.upsertTrack(track);
  if (dto.missing) return; // a placeholder for a playlist entry whose file isn't there: nothing to read

  // The file changed under the same id (the content hash differs): whatever art was cached is stale.
  const previous = await ctx.store.getMetadata(fileId);
  if (previous && dto.contentHash && previous.contentHash && previous.contentHash !== dto.contentHash) {
    await ctx.store.putCoverArt(fileId, null);
  }

  const metadata: TrackMetadata = {
    fileId,
    title: dto.title,
    artists: dto.artists,
    album: dto.album,
    durationSeconds: dto.durationSeconds,
    sizeBytes: dto.sizeBytes,
    lastModifiedMs: dto.lastModifiedMs,
    // Current, so the UI treats it as scanned and never polls for it - see isMetadataCurrent.
    parserVersion: METADATA_PARSER_VERSION,
    contentHash: dto.contentHash,
  };
  await ctx.store.putMetadata(metadata);

  if (dto.normalizationGain !== null) {
    await ctx.store.putAnalysis({
      fileId,
      normalizationGain: dto.normalizationGain,
      analyzedAtMs: ctx.now(),
      sizeBytes: dto.sizeBytes,
      lastModifiedMs: dto.lastModifiedMs,
      // The server runs this same analysis code, so what it computed is current by definition; with
      // this written, playing the track never re-analyses it on the device.
      algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
    });
  }
}

/** Applies one entry of the sync feed. Returns false for an entity the app doesn't use yet. */
export async function applyChange(ctx: ApplyContext, change: SyncChangeDto): Promise<boolean> {
  switch (change.entity) {
    case 'track': {
      const fileId = fileIdOf(change.id);
      if (fileId === null) return true;
      if (change.track) await applyTrack(ctx, fileId, change.track);
      else await ctx.store.deleteTrack(fileId);
      return true;
    }
    case 'playlist': {
      const id = fileIdOf(change.id);
      if (id === null) return true;
      if (!change.playlist) {
        await ctx.store.deletePlaylist(id);
        return true;
      }
      const playlist: PlaylistRecord = {
        id,
        rootId: change.playlist.rootId,
        fileId: id,
        name: change.playlist.name,
        trackFileIds: change.playlist.trackIds.map(fileIdOf).filter((fileId): fileId is string => fileId !== null),
      };
      await ctx.store.upsertPlaylist(playlist);
      return true;
    }
    case 'userPlaylist': {
      const id = `${USER_PLAYLIST_ID_PREFIX}${change.id}`;
      if (!change.userPlaylist) {
        await ctx.store.deletePlaylist(id);
        return true;
      }
      const rootId = ctx.defaultRootId();
      if (rootId === null) return true; // no library root to show it under yet; the next sync (after roots arrive) picks it up
      await ctx.store.upsertPlaylist({
        id,
        rootId,
        fileId: id,
        name: change.userPlaylist.name,
        trackFileIds: change.userPlaylist.trackIds.map(fileIdOf).filter((fileId): fileId is string => fileId !== null),
      });
      return true;
    }
    // Settings and per-device playback state sync is not wired into the app yet.
    case 'playbackState':
    case 'setting':
      return false;
  }
}
