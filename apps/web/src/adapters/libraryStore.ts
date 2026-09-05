import type {
  AnalysisResult,
  CoverArtBytes,
  LibraryStore,
  PlaybackState,
  PlaylistRecord,
  RootKind,
  TrackMetadata,
  TrackRecord,
} from '@bpmix/core';
import { idbDelete, idbGet, idbGetAll, idbPut, openDb } from './indexedDb';

const DB_NAME = 'bpmix-library';
// v5: added rootKind/lyricsAssignment object stores for the lyrics-folder
// feature - both created fresh below, nothing to migrate from v4.
const DB_VERSION = 5;
const TRACKS_STORE = 'tracks';
const PLAYLISTS_STORE = 'playlists';
const ANALYSIS_STORE = 'analysis';
const METADATA_STORE = 'metadata';
const COVER_ART_STORE = 'coverArt';
const PLAYBACK_STATE_STORE = 'playbackState';
const PLAYBACK_STATE_KEY = 'current';
const ROOT_KIND_STORE = 'rootKind';
const LYRICS_ASSIGNMENT_STORE = 'lyricsAssignment';
const DEFAULT_ROOT_KIND: RootKind = 'music';

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
    // Unconditionally dropped and recreated (not just created if absent,
    // like the other stores) - see DB_VERSION's doc comment for why an
    // older version's coverArt store can't just be reused as-is.
    if (db.objectStoreNames.contains(COVER_ART_STORE)) {
      db.deleteObjectStore(COVER_ART_STORE);
    }
    // Keyed explicitly (not via keyPath) - the value is a Blob, not an object with a fileId field.
    db.createObjectStore(COVER_ART_STORE);
    if (!db.objectStoreNames.contains(PLAYBACK_STATE_STORE)) {
      db.createObjectStore(PLAYBACK_STATE_STORE);
    }
    if (!db.objectStoreNames.contains(ROOT_KIND_STORE)) {
      db.createObjectStore(ROOT_KIND_STORE);
    }
    if (!db.objectStoreNames.contains(LYRICS_ASSIGNMENT_STORE)) {
      db.createObjectStore(LYRICS_ASSIGNMENT_STORE);
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

    // A real Blob, not a base64 data URI string - IndexedDB stores binary
    // values natively, so there's no need to pay the ~33% base64 size
    // overhead (or its CPU decode cost) that Android/Windows accept for
    // lack of any better storage primitive there (see their own
    // putCoverArt). URL.createObjectURL gives back a URI just as usable by
    // <Image source={{uri}}/> as a data: URI would be. That object URL is
    // intentionally never revoked - useCoverArt's cache resolves each
    // fileId at most once per session and holds onto the URL for as long
    // as the page lives, so there's nothing to revoke until the whole page
    // (and the URL along with it) goes away anyway.
    async getCoverArt(fileId: string): Promise<string | null> {
      const db = await getDb();
      const blob = await idbGet<Blob>(db, COVER_ART_STORE, fileId);
      return blob ? URL.createObjectURL(blob) : null;
    },
    async putCoverArt(fileId: string, art: CoverArtBytes | null): Promise<void> {
      const db = await getDb();
      if (art === null) {
        await idbDelete(db, COVER_ART_STORE, fileId);
      } else {
        const blob = new Blob([art.data as Uint8Array<ArrayBuffer>], { type: art.mimeType });
        await idbPut(db, COVER_ART_STORE, blob, fileId);
      }
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

    async getRootKind(rootId: string): Promise<RootKind> {
      const db = await getDb();
      const kind = await idbGet<RootKind>(db, ROOT_KIND_STORE, rootId);
      return kind ?? DEFAULT_ROOT_KIND;
    },
    async setRootKind(rootId: string, kind: RootKind): Promise<void> {
      const db = await getDb();
      await idbPut(db, ROOT_KIND_STORE, kind, rootId);
    },

    async getLyricsAssignment(fileId: string): Promise<string | null> {
      const db = await getDb();
      const lrcFileId = await idbGet<string>(db, LYRICS_ASSIGNMENT_STORE, fileId);
      return lrcFileId ?? null;
    },
    async putLyricsAssignment(fileId: string, lrcFileId: string | null): Promise<void> {
      const db = await getDb();
      if (lrcFileId === null) {
        await idbDelete(db, LYRICS_ASSIGNMENT_STORE, fileId);
      } else {
        await idbPut(db, LYRICS_ASSIGNMENT_STORE, lrcFileId, fileId);
      }
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
