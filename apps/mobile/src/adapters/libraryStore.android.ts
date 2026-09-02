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

  // CREATE TABLE IF NOT EXISTS is a no-op against a table created under an
  // older schema (e.g. from before the startWindow/endWindow split) - it
  // silently leaves the old columns in place, so every putAnalysis() insert
  // against the new column set fails with "no such column" and nothing
  // ever persists. Analysis results are fully re-derivable by re-running
  // analysis (unlike tracks/playlists, which come from the user's actual
  // files), so it's safe to just drop and recreate rather than write a
  // real migration.
  const analysisTableInfo = await run('PRAGMA table_info(analysis)');
  const analysisColumns = new Set<string>();
  for (let i = 0; i < analysisTableInfo.rows.length; i++) {
    analysisColumns.add((analysisTableInfo.rows.item(i) as { name: string }).name);
  }
  if (analysisColumns.size > 0 && !analysisColumns.has('startBpm')) {
    await run('DROP TABLE analysis');
  }

  await run(
    `CREATE TABLE IF NOT EXISTS analysis (
      fileId TEXT PRIMARY KEY,
      startBpm REAL NOT NULL,
      startBpmConfidence REAL NOT NULL,
      startBeatAnchorSeconds REAL NOT NULL,
      endBpm REAL NOT NULL,
      endBpmConfidence REAL NOT NULL,
      endBeatAnchorSeconds REAL NOT NULL,
      normalizationGain REAL NOT NULL,
      analyzedAtMs INTEGER NOT NULL,
      sizeBytes INTEGER NOT NULL,
      lastModifiedMs INTEGER NOT NULL
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
      const rows = rowsToArray<{
        fileId: string;
        startBpm: number;
        startBpmConfidence: number;
        startBeatAnchorSeconds: number;
        endBpm: number;
        endBpmConfidence: number;
        endBeatAnchorSeconds: number;
        normalizationGain: number;
        analyzedAtMs: number;
        sizeBytes: number;
        lastModifiedMs: number;
      }>(result);
      const row = rows[0];
      if (!row) return null;
      return {
        fileId: row.fileId,
        startWindow: {
          bpm: row.startBpm,
          bpmConfidence: row.startBpmConfidence,
          beatAnchorSeconds: row.startBeatAnchorSeconds,
        },
        endWindow: { bpm: row.endBpm, bpmConfidence: row.endBpmConfidence, beatAnchorSeconds: row.endBeatAnchorSeconds },
        normalizationGain: row.normalizationGain,
        analyzedAtMs: row.analyzedAtMs,
        sizeBytes: row.sizeBytes,
        lastModifiedMs: row.lastModifiedMs,
      };
    },

    async putAnalysis(analysisResult: AnalysisResult): Promise<void> {
      await ready;
      await run(
        `INSERT INTO analysis (
           fileId, startBpm, startBpmConfidence, startBeatAnchorSeconds,
           endBpm, endBpmConfidence, endBeatAnchorSeconds,
           normalizationGain, analyzedAtMs, sizeBytes, lastModifiedMs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fileId) DO UPDATE SET
           startBpm=excluded.startBpm, startBpmConfidence=excluded.startBpmConfidence,
           startBeatAnchorSeconds=excluded.startBeatAnchorSeconds,
           endBpm=excluded.endBpm, endBpmConfidence=excluded.endBpmConfidence,
           endBeatAnchorSeconds=excluded.endBeatAnchorSeconds,
           normalizationGain=excluded.normalizationGain, analyzedAtMs=excluded.analyzedAtMs,
           sizeBytes=excluded.sizeBytes, lastModifiedMs=excluded.lastModifiedMs`,
        [
          analysisResult.fileId,
          analysisResult.startWindow.bpm,
          analysisResult.startWindow.bpmConfidence,
          analysisResult.startWindow.beatAnchorSeconds,
          analysisResult.endWindow.bpm,
          analysisResult.endWindow.bpmConfidence,
          analysisResult.endWindow.beatAnchorSeconds,
          analysisResult.normalizationGain,
          analysisResult.analyzedAtMs,
          analysisResult.sizeBytes,
          analysisResult.lastModifiedMs,
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
