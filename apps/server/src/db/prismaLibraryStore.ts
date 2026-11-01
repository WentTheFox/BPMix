import { encodeTrackKey } from '@beatseam/api';
import type { LibraryStore, LyricsScope, PlaybackState, PlaylistRecord, TrackMetadata, TrackRecord } from '@beatseam/core';
import type { PrismaClient } from './prisma.js';

type TrackRow = { fileId: string; rootId: string; relativePath: string; sizeBytes: bigint; lastModifiedMs: number; missing: boolean };

function toTrack(row: TrackRow): TrackRecord {
  const track: TrackRecord = {
    fileId: row.fileId,
    rootId: row.rootId,
    relativePath: row.relativePath,
    sizeBytes: Number(row.sizeBytes),
    lastModifiedMs: row.lastModifiedMs,
  };
  if (row.missing) track.missing = true;
  return track;
}

function toPlaylist(row: { id: string; rootId: string; fileId: string; name: string; trackFileIds: string[] }): PlaylistRecord {
  return { id: row.id, rootId: row.rootId, fileId: row.fileId, name: row.name, trackFileIds: row.trackFileIds };
}

/**
 * The server's LibraryStore: lets @beatseam/core's scan/metadata/lyrics/analysis
 * code run against Postgres unchanged. Library-scoped methods are the real
 * data; playback state and settings are per-user concerns the scanner never
 * calls, so they're a plain key/value fallback until the per-user tables land
 * with auth.
 *
 * getCoverArt returns a server-relative URL (served by the cover route)
 * rather than an object URL like the browser store does.
 */
export function createPrismaLibraryStore(db: PrismaClient): LibraryStore {
  const getKv = async (key: string) => (await db.keyValue.findUnique({ where: { key } }))?.value ?? null;
  const putKv = async (key: string, value: string) => {
    await db.keyValue.upsert({ where: { key }, create: { key, value }, update: { value } });
  };

  return {
    async upsertTrack(track) {
      const data = {
        rootId: track.rootId,
        relativePath: track.relativePath,
        sizeBytes: BigInt(track.sizeBytes),
        lastModifiedMs: track.lastModifiedMs,
        missing: track.missing === true,
      };
      await db.track.upsert({ where: { fileId: track.fileId }, create: { fileId: track.fileId, ...data }, update: data });
    },
    async deleteTrack(fileId) {
      await db.track.deleteMany({ where: { fileId } });
    },
    async upsertPlaylist(playlist) {
      const data = { rootId: playlist.rootId, fileId: playlist.fileId, name: playlist.name, trackFileIds: playlist.trackFileIds };
      await db.playlist.upsert({ where: { id: playlist.id }, create: { id: playlist.id, ...data }, update: data });
    },
    async deletePlaylist(id) {
      await db.playlist.deleteMany({ where: { id } });
    },
    async listTracks(rootId) {
      return (await db.track.findMany({ where: { rootId } })).map(toTrack);
    },
    async listPlaylists(rootId) {
      return (await db.playlist.findMany({ where: { rootId } })).map(toPlaylist);
    },
    async listAllTracks() {
      return (await db.track.findMany()).map(toTrack);
    },
    async listAllPlaylists() {
      return (await db.playlist.findMany()).map(toPlaylist);
    },

    async getAnalysis(fileId) {
      const row = await db.trackAnalysis.findUnique({ where: { fileId } });
      return row ? { ...row, sizeBytes: Number(row.sizeBytes) } : null;
    },
    async putAnalysis(result) {
      const data = {
        normalizationGain: result.normalizationGain,
        analyzedAtMs: result.analyzedAtMs,
        sizeBytes: BigInt(result.sizeBytes),
        lastModifiedMs: result.lastModifiedMs,
        algorithmVersion: result.algorithmVersion,
      };
      await db.trackAnalysis.upsert({ where: { fileId: result.fileId }, create: { fileId: result.fileId, ...data }, update: data });
    },

    async getMetadata(fileId): Promise<TrackMetadata | null> {
      const row = await db.trackMetadata.findUnique({ where: { fileId } });
      return row ? { ...row, sizeBytes: Number(row.sizeBytes) } : null;
    },
    async putMetadata(result) {
      const data = {
        title: result.title,
        artists: result.artists,
        album: result.album,
        durationSeconds: result.durationSeconds,
        sizeBytes: BigInt(result.sizeBytes),
        lastModifiedMs: result.lastModifiedMs,
        parserVersion: result.parserVersion,
        contentHash: result.contentHash,
      };
      await db.trackMetadata.upsert({ where: { fileId: result.fileId }, create: { fileId: result.fileId, ...data }, update: data });
    },

    async getCoverArt(fileId) {
      const present = await db.coverArt.findUnique({ where: { fileId }, select: { fileId: true } });
      return present ? `/api/v1/tracks/${encodeTrackKey(fileId)}/cover` : null;
    },
    async putCoverArt(fileId, art) {
      if (!art) {
        await db.coverArt.deleteMany({ where: { fileId } });
        return;
      }
      const data = { mimeType: art.mimeType, data: Buffer.from(art.data) };
      await db.coverArt.upsert({ where: { fileId }, create: { fileId, ...data }, update: data });
    },

    async getPlaybackState() {
      const raw = await getKv('playbackState');
      return raw ? (JSON.parse(raw) as PlaybackState) : null;
    },
    async putPlaybackState(state) {
      await putKv('playbackState', JSON.stringify(state));
    },

    async getLyricsScopes(): Promise<LyricsScope[]> {
      return db.lyricsScope.findMany();
    },
    async addLyricsScope(scope) {
      await db.lyricsScope.upsert({
        where: { rootId_relativePath: scope },
        create: scope,
        update: {},
      });
    },
    async removeLyricsScope(rootId, relativePath) {
      await db.lyricsScope.deleteMany({ where: { rootId, relativePath } });
    },

    async getLyricsAssignment(fileId) {
      return (await db.lyricsAssignment.findUnique({ where: { fileId } }))?.lrcFileId ?? null;
    },
    async putLyricsAssignment(fileId, lrcFileId) {
      await db.lyricsAssignment.upsert({ where: { fileId }, create: { fileId, lrcFileId }, update: { lrcFileId } });
    },

    async getSetting(key) {
      return getKv(`setting:${key}`);
    },
    async putSetting(key, value) {
      await putKv(`setting:${key}`, value);
    },
  };
}
