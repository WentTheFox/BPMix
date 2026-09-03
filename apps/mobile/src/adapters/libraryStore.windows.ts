import type {
  AnalysisResult,
  LibraryStore,
  PlaybackState,
  PlaylistRecord,
  TrackMetadata,
  TrackRecord,
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

interface StoredData {
  tracks: TrackRecord[];
  playlists: PlaylistRecord[];
  analyses: Record<string, AnalysisResult>;
  metadata: Record<string, TrackMetadata>;
  playbackState: PlaybackState | null;
}

function emptyData(): StoredData {
  return { tracks: [], playlists: [], analyses: {}, metadata: {}, playbackState: null };
}

export function createLibraryStore(): LibraryStore {
  // Loaded lazily and cached; every mutating call writes the whole file
  // back through. Simple - not designed for a library large enough that
  // whole-file rewrites become a bottleneck.
  let loaded: Promise<StoredData> | null = null;

  async function load(): Promise<StoredData> {
    if (!loaded) {
      loaded = (async () => {
        const text = await native.readText(STORAGE_FILE);
        if (!text) {
          return emptyData();
        }
        try {
          const parsed = JSON.parse(text) as StoredData;
          parsed.metadata ??= {}; // absent in files written before metadata scanning existed
          return parsed;
        } catch {
          return emptyData();
        }
      })();
    }
    return loaded;
  }

  async function save(data: StoredData): Promise<void> {
    await native.writeText(STORAGE_FILE, JSON.stringify(data));
  }

  return {
    async upsertTrack(track: TrackRecord): Promise<void> {
      const data = await load();
      const index = data.tracks.findIndex((t) => t.fileId === track.fileId);
      if (index === -1) {
        data.tracks.push(track);
      } else {
        data.tracks[index] = track;
      }
      await save(data);
    },

    async upsertPlaylist(playlist: PlaylistRecord): Promise<void> {
      const data = await load();
      const index = data.playlists.findIndex((p) => p.id === playlist.id);
      if (index === -1) {
        data.playlists.push(playlist);
      } else {
        data.playlists[index] = playlist;
      }
      await save(data);
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
      const data = await load();
      data.analyses[result.fileId] = result;
      await save(data);
    },

    async getMetadata(fileId: string): Promise<TrackMetadata | null> {
      const data = await load();
      return data.metadata[fileId] ?? null;
    },

    async putMetadata(result: TrackMetadata): Promise<void> {
      const data = await load();
      data.metadata[result.fileId] = result;
      await save(data);
    },

    async getPlaybackState(): Promise<PlaybackState | null> {
      const data = await load();
      return data.playbackState;
    },

    async putPlaybackState(state: PlaybackState): Promise<void> {
      const data = await load();
      data.playbackState = state;
      await save(data);
    },
  };
}
