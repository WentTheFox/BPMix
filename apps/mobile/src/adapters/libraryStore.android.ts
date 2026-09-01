import type { AnalysisResult, LibraryStore, PlaybackState, PlaylistRecord, TrackRecord } from '@bpmix/core';
import SQLite, { type SQLError, type SQLResultSet, type SQLTransaction, type WebsqlDatabase } from 'react-native-sqlite-2';

const db: WebsqlDatabase = SQLite.openDatabase('bpmix.db', '1.0', '', 1);

function run(sql: string, params: (string | number | null)[] = []): Promise<SQLResultSet> {
  return new Promise((resolve, reject) => {
    db.transaction(
      (txn: SQLTransaction) => {
        txn.executeSql(
          sql,
          params,
          (_txn: SQLTransaction, result: SQLResultSet) => resolve(result),
          (_txn: SQLTransaction, error: SQLError) => {
            reject(error);
            return true; // roll back on any error rather than continuing in an inconsistent state
          },
        );
      },
      (error: SQLError) => reject(error),
    );
  });
}

const ready = (async () => {
  await run(
    `CREATE TABLE IF NOT EXISTS tracks (
      fileId TEXT PRIMARY KEY,
      rootId TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      sizeBytes INTEGER NOT NULL,
      lastModifiedMs INTEGER NOT NULL
    )`,
  );
  await run('CREATE INDEX IF NOT EXISTS idx_tracks_rootId ON tracks(rootId)');
  await run(
    `CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      rootId TEXT NOT NULL,
      fileId TEXT NOT NULL,
      name TEXT NOT NULL,
      trackFileIds TEXT NOT NULL
    )`,
  );
  await run('CREATE INDEX IF NOT EXISTS idx_playlists_rootId ON playlists(rootId)');
  await run(
    `CREATE TABLE IF NOT EXISTS analysis (
      fileId TEXT PRIMARY KEY,
      bpm REAL NOT NULL,
      bpmConfidence REAL NOT NULL,
      normalizationGain REAL NOT NULL,
      analyzedAtMs INTEGER NOT NULL
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS playback_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      playlistId TEXT,
      currentTrackFileId TEXT,
      positionSeconds REAL NOT NULL,
      loopMode TEXT NOT NULL,
      shuffleEnabled INTEGER NOT NULL
    )`,
  );
})();

function rowsToArray<T>(result: SQLResultSet): T[] {
  const out: T[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    out.push(result.rows.item(i) as T);
  }
  return out;
}

export function createLibraryStore(): LibraryStore {
  return {
    async upsertTrack(track: TrackRecord): Promise<void> {
      await ready;
      await run(
        `INSERT INTO tracks (fileId, rootId, relativePath, sizeBytes, lastModifiedMs) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fileId) DO UPDATE SET rootId=excluded.rootId, relativePath=excluded.relativePath,
           sizeBytes=excluded.sizeBytes, lastModifiedMs=excluded.lastModifiedMs`,
        [track.fileId, track.rootId, track.relativePath, track.sizeBytes, track.lastModifiedMs],
      );
    },

    async upsertPlaylist(playlist: PlaylistRecord): Promise<void> {
      await ready;
      await run(
        `INSERT INTO playlists (id, rootId, fileId, name, trackFileIds) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET rootId=excluded.rootId, fileId=excluded.fileId,
           name=excluded.name, trackFileIds=excluded.trackFileIds`,
        [playlist.id, playlist.rootId, playlist.fileId, playlist.name, JSON.stringify(playlist.trackFileIds)],
      );
    },

    async listTracks(rootId: string): Promise<TrackRecord[]> {
      await ready;
      const result = await run('SELECT * FROM tracks WHERE rootId = ?', [rootId]);
      return rowsToArray<TrackRecord>(result);
    },

    async listPlaylists(rootId: string): Promise<PlaylistRecord[]> {
      await ready;
      const result = await run('SELECT * FROM playlists WHERE rootId = ?', [rootId]);
      return rowsToArray<{ id: string; rootId: string; fileId: string; name: string; trackFileIds: string }>(
        result,
      ).map((row) => ({ ...row, trackFileIds: JSON.parse(row.trackFileIds) as string[] }));
    },

    async getAnalysis(fileId: string): Promise<AnalysisResult | null> {
      await ready;
      const result = await run('SELECT * FROM analysis WHERE fileId = ?', [fileId]);
      const rows = rowsToArray<AnalysisResult>(result);
      return rows[0] ?? null;
    },

    async putAnalysis(analysisResult: AnalysisResult): Promise<void> {
      await ready;
      await run(
        `INSERT INTO analysis (fileId, bpm, bpmConfidence, normalizationGain, analyzedAtMs) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fileId) DO UPDATE SET bpm=excluded.bpm, bpmConfidence=excluded.bpmConfidence,
           normalizationGain=excluded.normalizationGain, analyzedAtMs=excluded.analyzedAtMs`,
        [
          analysisResult.fileId,
          analysisResult.bpm,
          analysisResult.bpmConfidence,
          analysisResult.normalizationGain,
          analysisResult.analyzedAtMs,
        ],
      );
    },

    async getPlaybackState(): Promise<PlaybackState | null> {
      await ready;
      const result = await run('SELECT * FROM playback_state WHERE id = 1');
      const rows = rowsToArray<{
        playlistId: string | null;
        currentTrackFileId: string | null;
        positionSeconds: number;
        loopMode: PlaybackState['loopMode'];
        shuffleEnabled: number;
      }>(result);
      const row = rows[0];
      if (!row) return null;
      return { ...row, shuffleEnabled: row.shuffleEnabled === 1 };
    },

    async putPlaybackState(state: PlaybackState): Promise<void> {
      await ready;
      await run(
        `INSERT INTO playback_state (id, playlistId, currentTrackFileId, positionSeconds, loopMode, shuffleEnabled)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET playlistId=excluded.playlistId, currentTrackFileId=excluded.currentTrackFileId,
           positionSeconds=excluded.positionSeconds, loopMode=excluded.loopMode, shuffleEnabled=excluded.shuffleEnabled`,
        [state.playlistId, state.currentTrackFileId, state.positionSeconds, state.loopMode, state.shuffleEnabled ? 1 : 0],
      );
    },
  };
}
