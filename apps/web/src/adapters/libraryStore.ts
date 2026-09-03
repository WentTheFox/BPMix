import type { AnalysisResult, LibraryStore, PlaybackState, PlaylistRecord, TrackMetadata, TrackRecord } from '@bpmix/core';
import { idbGet, idbGetAll, idbPut, openDb } from './indexedDb';

const DB_NAME = 'bpmix-library';
const DB_VERSION = 2;
const TRACKS_STORE = 'tracks';
const PLAYLISTS_STORE = 'playlists';
const ANALYSIS_STORE = 'analysis';
const METADATA_STORE = 'metadata';
const PLAYBACK_STATE_STORE = 'playbackState';
const PLAYBACK_STATE_KEY = 'current';

function getDb(): Promise<IDBDatabase> {
  return openDb(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(TRACKS_STORE)) {
      db.createObjectStore(TRACKS_STORE, { keyPath: 'fileId' }).createIndex('rootId', 'rootId');
    }
    if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
      db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id' }).createIndex('rootId', 'rootId');
    }
    if (!db.objectStoreNames.contains(ANALYSIS_STORE)) {
      db.createObjectStore(ANALYSIS_STORE, { keyPath: 'fileId' });
    }
    if (!db.objectStoreNames.contains(METADATA_STORE)) {
      db.createObjectStore(METADATA_STORE, { keyPath: 'fileId' });
    }
    if (!db.objectStoreNames.contains(PLAYBACK_STATE_STORE)) {
      db.createObjectStore(PLAYBACK_STATE_STORE);
    }
  });
}

function byIndex<T>(db: IDBDatabase, storeName: string, indexName: string, value: IDBValidKey): Promise<T[]> {
  const tx = db.transaction(storeName, 'readonly');
  const request = tx.objectStore(storeName).index(indexName).getAll(value);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createLibraryStore(): LibraryStore {
  return {
    async upsertTrack(track: TrackRecord): Promise<void> {
      const db = await getDb();
      await idbPut(db, TRACKS_STORE, track);
    },
    async upsertPlaylist(playlist: PlaylistRecord): Promise<void> {
      const db = await getDb();
      await idbPut(db, PLAYLISTS_STORE, playlist);
    },
    async listTracks(rootId: string): Promise<TrackRecord[]> {
      const db = await getDb();
      return byIndex<TrackRecord>(db, TRACKS_STORE, 'rootId', rootId);
    },
    async listPlaylists(rootId: string): Promise<PlaylistRecord[]> {
      const db = await getDb();
      return byIndex<PlaylistRecord>(db, PLAYLISTS_STORE, 'rootId', rootId);
    },

    async getAnalysis(fileId: string): Promise<AnalysisResult | null> {
      const db = await getDb();
      const result = await idbGet<AnalysisResult>(db, ANALYSIS_STORE, fileId);
      return result ?? null;
    },
    async putAnalysis(result: AnalysisResult): Promise<void> {
      const db = await getDb();
      await idbPut(db, ANALYSIS_STORE, result);
    },

    async getMetadata(fileId: string): Promise<TrackMetadata | null> {
      const db = await getDb();
      const result = await idbGet<TrackMetadata>(db, METADATA_STORE, fileId);
      return result ?? null;
    },
    async putMetadata(result: TrackMetadata): Promise<void> {
      const db = await getDb();
      await idbPut(db, METADATA_STORE, result);
    },

    async getPlaybackState(): Promise<PlaybackState | null> {
      const db = await getDb();
      const state = await idbGet<PlaybackState>(db, PLAYBACK_STATE_STORE, PLAYBACK_STATE_KEY);
      return state ?? null;
    },
    async putPlaybackState(state: PlaybackState): Promise<void> {
      const db = await getDb();
      const tx = db.transaction(PLAYBACK_STATE_STORE, 'readwrite');
      tx.objectStore(PLAYBACK_STATE_STORE).put(state, PLAYBACK_STATE_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

// Also list every granted root's stored playlists, needed by the UI to
// restore the library screen without a fresh scan on every launch.
export async function listAllRootIds(): Promise<string[]> {
  const db = await getDb();
  const tracks = await idbGetAll<TrackRecord>(db, TRACKS_STORE);
  return [...new Set(tracks.map((t) => t.rootId))];
}
