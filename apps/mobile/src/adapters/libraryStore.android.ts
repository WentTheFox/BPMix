import {
  encodeBase64,
  type AnalysisResult,
  type CoverArtBytes,
  type LibraryStore,
  type LyricsScope,
  type PlaybackState,
  type PlaylistRecord,
  type TrackMetadata,
  type TrackRecord,
} from '@bpmix/core';
import { NativeModules } from 'react-native';
import SQLite, { type SQLError, type SQLResultSet, type SQLTransaction, type WebsqlDatabase } from 'react-native-sqlite-2';

/** Subset of BPMixFileAccessModule (see its .kt for the rest) used here to cache cover art as real files instead of base64 SQLite TEXT - see putCoverArt's doc. */
interface NativeLocalFiles {
  writeLocalBytesBase64(fileName: string, base64Data: string): Promise<string>;
  deleteLocalFile(fileName: string): Promise<void>;
}
const nativeFiles = NativeModules.BPMixFileAccess as NativeLocalFiles;

/**
 * FNV-1a hash of fileId, used only to build a safe cover-art cache filename -
 * fileId itself is a full external-storage path (see fileAccess.android.ts),
 * which can contain "/" and arbitrary characters, none of which are safe to
 * hand straight to writeLocalBytesBase64 as a filename. Same pattern as
 * libraryStore.windows.ts's coverArtFileName; collisions are astronomically
 * unlikely for any real library and would just misattribute one track's art
 * to another, not corrupt anything.
 */
function coverArtFileName(fileId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < fileId.length; i++) {
    hash ^= fileId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `coverArt/cover-${(hash >>> 0).toString(16)}`;
}

const db: WebsqlDatabase = SQLite.openDatabase('bpmix.db', '1.0', '', 1);

// react-native-sqlite-2 (a WebSQL polyfill) serializes every transaction
// onto this one connection regardless of call order stability - dozens of
// TrackRow-driven getCoverArt/getMetadata calls firing at once on library
// mount used to bury the currently-playing track's own getLyricsAssignment/
// getMetadata lookup for many seconds behind them (confirmed live via
// [PERF] timing: ~16s cold, ~6.5s warm just to resolve the now-playing
// track's lyrics assignment). Fixed by taking explicit control of dispatch
// order here instead of relying on whatever order db.transaction() calls
// happened to arrive in: every run() call is queued as a Job first, and a
// job tagged with the current track's fileId (see setPriorityFileId, called
// from App.tsx whenever the now-playing track changes) jumps to the front
// of that queue instead of waiting behind unrelated rows. Doesn't change
// total throughput (the underlying SQLite connection was already fully
// serial), just which pending job gets dispatched next.
interface Job {
  sql: string;
  params: (string | number | null)[];
  fileId: string | undefined;
  resolve: (result: SQLResultSet) => void;
  reject: (error: unknown) => void;
}

const queue: Job[] = [];
let draining = false;
let priorityFileId: string | null = null;

/** Called from App.tsx whenever the now-playing track changes, so its own metadata/lyrics-assignment/cover-art reads always jump the queue ahead of unrelated background rows. Windows/web have no equivalent queue to prioritize, so this export is Android-only. */
export function setPriorityFileId(fileId: string | null): void {
  priorityFileId = fileId;
}

function executeJob(job: Job): void {
  db.transaction(
    (txn: SQLTransaction) => {
      txn.executeSql(
        job.sql,
        job.params,
        (_txn: SQLTransaction, result: SQLResultSet) => job.resolve(result),
        (_txn: SQLTransaction, error: SQLError) => {
          job.reject(error);
          return true; // roll back on any error rather than continuing in an inconsistent state
        },
      );
    },
    (error: SQLError) => job.reject(error),
  );
}

function drainQueue(): void {
  if (draining) return;
  draining = true;
  const step = (): void => {
    // Re-evaluated on every step (not just once at enqueue time) since
    // priorityFileId can change while older jobs still sit in the queue.
    const priorityIndex = priorityFileId ? queue.findIndex((j) => j.fileId === priorityFileId) : -1;
    const job = priorityIndex !== -1 ? queue.splice(priorityIndex, 1)[0]! : queue.shift();
    if (!job) {
      draining = false;
      return;
    }
    executeJob({
      ...job,
      resolve: (result) => {
        job.resolve(result);
        step();
      },
      reject: (error) => {
        job.reject(error);
        step();
      },
    });
  };
  step();
}

/** `fileId`, when given, lets a job tagged with the current priority track (see setPriorityFileId) jump the queue ahead of unrelated pending reads. */
function run(sql: string, params: (string | number | null)[] = [], fileId?: string): Promise<SQLResultSet> {
  return new Promise((resolve, reject) => {
    queue.push({ sql, params, fileId, resolve, reject });
    drainQueue();
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
  // older schema (e.g. from before algorithmVersion was added, or before the
  // startWindow/endWindow BPM columns were dropped in favor of a live/
  // just-in-time BPM calibration instead of a precomputed one - see
  // CLAUDE.md's crossfade rework) - it silently leaves the old columns in
  // place, so every putAnalysis() insert against the new column set fails
  // with "no such column" and nothing ever persists. Analysis results are
  // fully re-derivable by re-running analysis (unlike tracks/playlists,
  // which come from the user's actual files), so it's safe to just drop and
  // recreate rather than write a real migration.
  const analysisTableInfo = await run('PRAGMA table_info(analysis)');
  const analysisColumns = new Set<string>();
  for (let i = 0; i < analysisTableInfo.rows.length; i++) {
    analysisColumns.add((analysisTableInfo.rows.item(i) as { name: string }).name);
  }
  if (analysisColumns.size > 0 && (analysisColumns.has('startBpm') || !analysisColumns.has('algorithmVersion'))) {
    await run('DROP TABLE analysis');
  }

  await run(
    `CREATE TABLE IF NOT EXISTS analysis (
      fileId TEXT PRIMARY KEY,
      normalizationGain REAL NOT NULL,
      analyzedAtMs INTEGER NOT NULL,
      sizeBytes INTEGER NOT NULL,
      lastModifiedMs INTEGER NOT NULL,
      algorithmVersion INTEGER NOT NULL
    )`,
  );
  // Same reasoning/pattern as the analysis table's migration guard above -
  // a table created before the `volume`/`rootId`/`nowPlayingOpen`/
  // `shuffleOrder` columns existed would silently reject every
  // putPlaybackState() insert with "no such column".
  const playbackStateTableInfo = await run('PRAGMA table_info(playback_state)');
  const playbackStateColumns = new Set<string>();
  for (let i = 0; i < playbackStateTableInfo.rows.length; i++) {
    playbackStateColumns.add((playbackStateTableInfo.rows.item(i) as { name: string }).name);
  }
  if (
    playbackStateColumns.size > 0 &&
    (!playbackStateColumns.has('volume') ||
      !playbackStateColumns.has('rootId') ||
      !playbackStateColumns.has('nowPlayingOpen') ||
      !playbackStateColumns.has('shuffleOrder'))
  ) {
    await run('DROP TABLE playback_state');
  }

  // Same drop-and-recreate pattern as the analysis table above - metadata
  // is just as fully re-derivable by re-scanning the file, so a schema
  // mismatch (here: a table from before contentHash/durationSeconds existed)
  // gets dropped rather than migrated.
  const metadataTableInfo = await run('PRAGMA table_info(metadata)');
  const metadataColumns = new Set<string>();
  for (let i = 0; i < metadataTableInfo.rows.length; i++) {
    metadataColumns.add((metadataTableInfo.rows.item(i) as { name: string }).name);
  }
  if (metadataColumns.size > 0 && (!metadataColumns.has('contentHash') || !metadataColumns.has('durationSeconds'))) {
    await run('DROP TABLE metadata');
  }

  await run(
    `CREATE TABLE IF NOT EXISTS metadata (
      fileId TEXT PRIMARY KEY,
      title TEXT,
      artists TEXT NOT NULL,
      album TEXT,
      durationSeconds REAL,
      sizeBytes INTEGER NOT NULL,
      lastModifiedMs INTEGER NOT NULL,
      parserVersion INTEGER NOT NULL,
      contentHash TEXT
    )`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS cover_art (
      fileId TEXT PRIMARY KEY,
      dataUri TEXT NOT NULL
    )`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS playback_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      playlistId TEXT,
      currentTrackFileId TEXT,
      rootId TEXT,
      positionSeconds REAL NOT NULL,
      loopMode TEXT NOT NULL,
      shuffleEnabled INTEGER NOT NULL,
      shuffleOrder TEXT,
      volume REAL NOT NULL,
      nowPlayingOpen INTEGER NOT NULL
    )`,
  );

  // root_kind was a short-lived whole-root "this is a lyrics folder" tag,
  // replaced by lyrics_scope (rootId + relativePath) - see LyricsScope's
  // doc. Dropped rather than migrated: never shipped with real user data.
  await run('DROP TABLE IF EXISTS root_kind');

  await run(
    `CREATE TABLE IF NOT EXISTS lyrics_scope (
      rootId TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      PRIMARY KEY (rootId, relativePath)
    )`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS lyrics_assignment (
      fileId TEXT PRIMARY KEY,
      lrcFileId TEXT NOT NULL
    )`,
  );

  // Generic string key-value store - see LibraryStore.getSetting's doc.
  await run(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
        normalizationGain: number;
        analyzedAtMs: number;
        sizeBytes: number;
        lastModifiedMs: number;
        algorithmVersion: number;
      }>(result);
      const row = rows[0];
      if (!row) return null;
      return {
        fileId: row.fileId,
        normalizationGain: row.normalizationGain,
        analyzedAtMs: row.analyzedAtMs,
        sizeBytes: row.sizeBytes,
        lastModifiedMs: row.lastModifiedMs,
        algorithmVersion: row.algorithmVersion,
      };
    },

    async putAnalysis(analysisResult: AnalysisResult): Promise<void> {
      await ready;
      await run(
        `INSERT INTO analysis (
           fileId, normalizationGain, analyzedAtMs, sizeBytes, lastModifiedMs, algorithmVersion
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(fileId) DO UPDATE SET
           normalizationGain=excluded.normalizationGain, analyzedAtMs=excluded.analyzedAtMs,
           sizeBytes=excluded.sizeBytes, lastModifiedMs=excluded.lastModifiedMs,
           algorithmVersion=excluded.algorithmVersion`,
        [
          analysisResult.fileId,
          analysisResult.normalizationGain,
          analysisResult.analyzedAtMs,
          analysisResult.sizeBytes,
          analysisResult.lastModifiedMs,
          analysisResult.algorithmVersion,
        ],
      );
    },

    async getMetadata(fileId: string): Promise<TrackMetadata | null> {
      await ready;
      const result = await run('SELECT * FROM metadata WHERE fileId = ?', [fileId], fileId);
      const rows = rowsToArray<{
        fileId: string;
        title: string | null;
        artists: string;
        album: string | null;
        durationSeconds: number | null;
        sizeBytes: number;
        lastModifiedMs: number;
        parserVersion: number;
        contentHash: string | null;
      }>(result);
      const row = rows[0];
      if (!row) return null;
      return { ...row, artists: JSON.parse(row.artists) as string[] };
    },

    async putMetadata(result: TrackMetadata): Promise<void> {
      await ready;
      await run(
        `INSERT INTO metadata (
           fileId, title, artists, album, durationSeconds, sizeBytes, lastModifiedMs, parserVersion, contentHash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fileId) DO UPDATE SET
           title=excluded.title, artists=excluded.artists, album=excluded.album, durationSeconds=excluded.durationSeconds,
           sizeBytes=excluded.sizeBytes, lastModifiedMs=excluded.lastModifiedMs, parserVersion=excluded.parserVersion,
           contentHash=excluded.contentHash`,
        [
          result.fileId,
          result.title,
          JSON.stringify(result.artists),
          result.album,
          result.durationSeconds,
          result.sizeBytes,
          result.lastModifiedMs,
          result.parserVersion,
          result.contentHash,
        ],
      );
    },

    async getCoverArt(fileId: string): Promise<string | null> {
      await ready;
      const result = await run('SELECT dataUri FROM cover_art WHERE fileId = ?', [fileId], fileId);
      const rows = rowsToArray<{ dataUri: string }>(result);
      return rows[0]?.dataUri ?? null;
    },

    // Writes the decoded bytes to a cache file (via the native module) and
    // stores only the resulting file:// path in SQLite - the dataUri column
    // name is unchanged (no migration needed: a getCoverArt read just
    // returns whatever's in that column, and <Image source={{uri}}/> renders
    // a data: URI or a file:// URI identically, so any pre-existing
    // base64-data-URI rows from before this change keep working as-is until
    // they're naturally rewritten by a future rescan). See
    // BPMixFileAccessModule.kt's writeLocalBytesBase64 doc for why this
    // beats storing base64 text directly (as Windows's libraryStore still
    // does, and as this used to).
    async putCoverArt(fileId: string, art: CoverArtBytes | null): Promise<void> {
      await ready;
      const fileName = coverArtFileName(fileId);
      if (art === null) {
        await run('DELETE FROM cover_art WHERE fileId = ?', [fileId]);
        await nativeFiles.deleteLocalFile(fileName).catch(() => {});
      } else {
        const path = await nativeFiles.writeLocalBytesBase64(fileName, encodeBase64(art.data));
        await run(
          `INSERT INTO cover_art (fileId, dataUri) VALUES (?, ?)
           ON CONFLICT(fileId) DO UPDATE SET dataUri=excluded.dataUri`,
          [fileId, `file://${path}`],
        );
      }
    },

    async getPlaybackState(): Promise<PlaybackState | null> {
      await ready;
      const result = await run('SELECT * FROM playback_state WHERE id = 1');
      const rows = rowsToArray<{
        playlistId: string | null;
        currentTrackFileId: string | null;
        rootId: string | null;
        positionSeconds: number;
        loopMode: PlaybackState['loopMode'];
        shuffleEnabled: number;
        shuffleOrder: string | null;
        volume: number;
        nowPlayingOpen: number;
      }>(result);
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        shuffleEnabled: row.shuffleEnabled === 1,
        shuffleOrder: row.shuffleOrder ? (JSON.parse(row.shuffleOrder) as string[]) : null,
        nowPlayingOpen: row.nowPlayingOpen === 1,
      };
    },

    async putPlaybackState(state: PlaybackState): Promise<void> {
      await ready;
      await run(
        `INSERT INTO playback_state (id, playlistId, currentTrackFileId, rootId, positionSeconds, loopMode, shuffleEnabled, shuffleOrder, volume, nowPlayingOpen)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET playlistId=excluded.playlistId, currentTrackFileId=excluded.currentTrackFileId,
           rootId=excluded.rootId, positionSeconds=excluded.positionSeconds, loopMode=excluded.loopMode,
           shuffleEnabled=excluded.shuffleEnabled, shuffleOrder=excluded.shuffleOrder, volume=excluded.volume,
           nowPlayingOpen=excluded.nowPlayingOpen`,
        [
          state.playlistId,
          state.currentTrackFileId,
          state.rootId,
          state.positionSeconds,
          state.loopMode,
          state.shuffleEnabled ? 1 : 0,
          state.shuffleOrder ? JSON.stringify(state.shuffleOrder) : null,
          state.volume,
          state.nowPlayingOpen ? 1 : 0,
        ],
      );
    },

    async getLyricsScopes(): Promise<LyricsScope[]> {
      await ready;
      const result = await run('SELECT rootId, relativePath FROM lyrics_scope');
      return rowsToArray<LyricsScope>(result);
    },

    async addLyricsScope(scope: LyricsScope): Promise<void> {
      await ready;
      await run(
        `INSERT INTO lyrics_scope (rootId, relativePath) VALUES (?, ?)
         ON CONFLICT(rootId, relativePath) DO NOTHING`,
        [scope.rootId, scope.relativePath],
      );
    },

    async removeLyricsScope(rootId: string, relativePath: string): Promise<void> {
      await ready;
      await run('DELETE FROM lyrics_scope WHERE rootId = ? AND relativePath = ?', [rootId, relativePath]);
    },

    async getLyricsAssignment(fileId: string): Promise<string | null> {
      await ready;
      const result = await run('SELECT lrcFileId FROM lyrics_assignment WHERE fileId = ?', [fileId], fileId);
      const rows = rowsToArray<{ lrcFileId: string }>(result);
      return rows[0]?.lrcFileId ?? null;
    },

    async putLyricsAssignment(fileId: string, lrcFileId: string | null): Promise<void> {
      await ready;
      if (lrcFileId === null) {
        await run('DELETE FROM lyrics_assignment WHERE fileId = ?', [fileId]);
      } else {
        await run(
          `INSERT INTO lyrics_assignment (fileId, lrcFileId) VALUES (?, ?)
           ON CONFLICT(fileId) DO UPDATE SET lrcFileId=excluded.lrcFileId`,
          [fileId, lrcFileId],
        );
      }
    },

    async getSetting(key: string): Promise<string | null> {
      await ready;
      const result = await run('SELECT value FROM settings WHERE key = ?', [key]);
      const rows = rowsToArray<{ value: string }>(result);
      return rows[0]?.value ?? null;
    },

    async putSetting(key: string, value: string): Promise<void> {
      await ready;
      await run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [key, value],
      );
    },
  };
}
