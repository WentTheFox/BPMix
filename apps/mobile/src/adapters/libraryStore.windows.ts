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

/**
 * Backed by a real native module (windows/Mobile/LocalStorageModule.h) that
 * reads/writes a whole text file in the app's own sandboxed local-data
 * folder - see that module's header comment for why (every third-party
 * Windows persistence library found ships pre-NuGet-era project files that
 * don't link against the current C++/WinRT template). All the actual
 * collection logic lives here in TypeScript; native only provides
 * read/write-a-file primitives.
 */
interface NativeLocalStorage {
  readText(fileName: string): Promise<string | null>;
  writeText(fileName: string, content: string): Promise<void>;
}

const native = NativeModules.BPMixLocalStorage as NativeLocalStorage;

const STORAGE_FILE = 'library-store.json';

/**
 * FNV-1a hash of fileId, used only to build a safe cover-art filename -
 * fileId itself is "<futureAccessListToken>|<relativePath>" on this
 * platform (see fileAccess.windows.ts), which can contain path separators,
 * a literal "|", and arbitrary filename characters, none of which are
 * safe to hand straight to the native module's writeText/readText.
 * Collisions are astronomically unlikely for any real library and would
 * just misattribute one track's art to another, not corrupt anything.
 */
function coverArtFileName(fileId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < fileId.length; i++) {
    hash ^= fileId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `cover-${(hash >>> 0).toString(16)}.txt`;
}

interface StoredData {
  tracks: TrackRecord[];
  playlists: PlaylistRecord[];
  analyses: Record<string, AnalysisResult>;
  metadata: Record<string, TrackMetadata>;
  playbackState: PlaybackState | null;
  /** See LyricsScope's doc - replaces the short-lived rootKinds field (never shipped with real user data, so no migration). */
  lyricsScopes: LyricsScope[];
  lyricsAssignments: Record<string, string>;
}

function emptyData(): StoredData {
  return { tracks: [], playlists: [], analyses: {}, metadata: {}, playbackState: null, lyricsScopes: [], lyricsAssignments: {} };
}

export function createLibraryStore(): LibraryStore {
  // Reads are cheap to cache in memory (a small local file), but a mutation
  // must NOT write that stale cached copy back out - see mutate()'s doc for
  // why. The cache still gets kept up to date on every mutation (see
  // mutate()), it's just never the thing actually written.
  let loaded: Promise<StoredData> | null = null;

  async function readFresh(): Promise<StoredData> {
    const text = await native.readText(STORAGE_FILE);
    if (!text) {
      return emptyData();
    }
    try {
      const parsed = JSON.parse(text) as StoredData;
      parsed.metadata ??= {}; // absent in files written before metadata scanning existed
      parsed.lyricsScopes ??= []; // absent in files written before lyrics folders existed
      parsed.lyricsAssignments ??= {};
      return parsed;
    } catch {
      return emptyData();
    }
  }

  async function load(): Promise<StoredData> {
    if (!loaded) {
      loaded = readFresh();
    }
    return loaded;
  }

  /**
   * Re-reads the file fresh and applies `apply` to *that* copy, rather than
   * mutating and re-saving whatever load() has cached - this module is a
   * `const` at the top of App.tsx, so every Fast Refresh reload (edit any
   * file it imports, even transitively) creates a brand new instance of
   * this whole store with its own fresh `loaded` cache, while the OLD
   * instance's in-flight async work (in practice, scanLibraryMetadata's
   * background loop, which for a large library can still be running
   * minutes later, well past several intervening reloads) keeps right on
   * calling this. If that old instance's writes had gone on saving ITS
   * OWN long-cached (now stale) snapshot, each one would silently wipe out
   * everything written since - including, in practice, a playlist a rescan
   * had just added on the newer instance. Reading fresh right before every
   * write closes that window: even a very stale caller's write only ever
   * layers its own specific change onto whatever is *currently* on disk.
   */
  async function mutate(apply: (data: StoredData) => void): Promise<void> {
    const data = await readFresh();
    apply(data);
    await native.writeText(STORAGE_FILE, JSON.stringify(data));
    loaded = Promise.resolve(data); // keep the read cache consistent with what's now on disk
  }

  return {
    async upsertTrack(track: TrackRecord): Promise<void> {
      await mutate((data) => {
        const index = data.tracks.findIndex((t) => t.fileId === track.fileId);
        if (index === -1) {
          data.tracks.push(track);
        } else {
          data.tracks[index] = track;
        }
      });
    },

    async upsertPlaylist(playlist: PlaylistRecord): Promise<void> {
      await mutate((data) => {
        const index = data.playlists.findIndex((p) => p.id === playlist.id);
        if (index === -1) {
          data.playlists.push(playlist);
        } else {
          data.playlists[index] = playlist;
        }
      });
    },

    async listTracks(rootId: string): Promise<TrackRecord[]> {
      const data = await load();
      return data.tracks.filter((t) => t.rootId === rootId);
    },

    async listPlaylists(rootId: string): Promise<PlaylistRecord[]> {
      const data = await load();
      return data.playlists.filter((p) => p.rootId === rootId);
    },

    async getAnalysis(fileId: string): Promise<AnalysisResult | null> {
      const data = await load();
      return data.analyses[fileId] ?? null;
    },

    async putAnalysis(result: AnalysisResult): Promise<void> {
      await mutate((data) => {
        data.analyses[result.fileId] = result;
      });
    },

    async getMetadata(fileId: string): Promise<TrackMetadata | null> {
      const data = await load();
      return data.metadata[fileId] ?? null;
    },

    async putMetadata(result: TrackMetadata): Promise<void> {
      await mutate((data) => {
        data.metadata[result.fileId] = result;
      });
    },

    // Deliberately its own small file per track rather than a field in
    // StoredData: art is tens to hundreds of KB, and mutate() rewrites the
    // *entire* library-store.json on every mutation - folding art in there
    // would make every unrelated write (e.g. a playback position update)
    // drag the whole library's art along with it.
    async getCoverArt(fileId: string): Promise<string | null> {
      const text = await native.readText(coverArtFileName(fileId));
      return text || null;
    },

    // Storage here is text-only (see the module header comment), so this
    // encodes to a data: URI itself - unlike web, which can store the raw
    // bytes directly and skip base64 entirely (see libraryStore.ts's
    // putCoverArt).
    async putCoverArt(fileId: string, art: CoverArtBytes | null): Promise<void> {
      const dataUri = art ? `data:${art.mimeType};base64,${encodeBase64(art.data)}` : '';
      await native.writeText(coverArtFileName(fileId), dataUri);
    },

    async getPlaybackState(): Promise<PlaybackState | null> {
      const data = await load();
      return data.playbackState;
    },

    async putPlaybackState(state: PlaybackState): Promise<void> {
      await mutate((data) => {
        data.playbackState = state;
      });
    },

    async getLyricsScopes(): Promise<LyricsScope[]> {
      const data = await load();
      return data.lyricsScopes;
    },

    async addLyricsScope(scope: LyricsScope): Promise<void> {
      await mutate((data) => {
        const exists = data.lyricsScopes.some((s) => s.rootId === scope.rootId && s.relativePath === scope.relativePath);
        if (!exists) {
          data.lyricsScopes.push(scope);
        }
      });
    },

    async removeLyricsScope(rootId: string, relativePath: string): Promise<void> {
      await mutate((data) => {
        data.lyricsScopes = data.lyricsScopes.filter((s) => !(s.rootId === rootId && s.relativePath === relativePath));
      });
    },

    async getLyricsAssignment(fileId: string): Promise<string | null> {
      const data = await load();
      return data.lyricsAssignments[fileId] ?? null;
    },

    async putLyricsAssignment(fileId: string, lrcFileId: string | null): Promise<void> {
      await mutate((data) => {
        if (lrcFileId === null) {
          delete data.lyricsAssignments[fileId];
        } else {
          data.lyricsAssignments[fileId] = lrcFileId;
        }
      });
    },
  };
}
