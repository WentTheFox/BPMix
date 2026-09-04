import type { CoverArtBytes, TrackMetadata } from '../metadata/types';

export interface TrackRecord {
  /** Matches FileRef.id. */
  fileId: string;
  rootId: string;
  relativePath: string;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface PlaylistRecord {
  id: string;
  rootId: string;
  fileId: string;
  name: string;
  /** Ordered list of track fileIds, resolved from the m3u8's entries. */
  trackFileIds: string[];
}

export interface AnalysisResult {
  fileId: string;
  /** Gain multiplier to apply so this track matches the reference loudness target. */
  normalizationGain: number;
  analyzedAtMs: number;
  /**
   * The TrackRecord's sizeBytes/lastModifiedMs at analysis time - fileId
   * alone isn't a content identity (it's derived from the file's path, so
   * a file edited in place keeps the same fileId), so freshness checks
   * compare these against the current TrackRecord to detect changed files.
   */
  sizeBytes: number;
  lastModifiedMs: number;
  /** ANALYSIS_ALGORITHM_VERSION at analysis time - a mismatch means the algorithm changed since, so the result is stale even though the file itself didn't. */
  algorithmVersion: number;
}

export type LoopMode = 'off' | 'all' | 'one';

export interface PlaybackState {
  playlistId: string | null;
  currentTrackFileId: string | null;
  positionSeconds: number;
  loopMode: LoopMode;
  shuffleEnabled: boolean;
  /** User-facing master volume [0,1] - see PlaylistPlayer.setVolume. Persisted so the next launch doesn't blast out at whatever volume happened to be in effect (e.g. full, its default) before it's set once. */
  volume: number;
}

export interface LibraryStore {
  upsertTrack(track: TrackRecord): Promise<void>;
  upsertPlaylist(playlist: PlaylistRecord): Promise<void>;
  listTracks(rootId: string): Promise<TrackRecord[]>;
  listPlaylists(rootId: string): Promise<PlaylistRecord[]>;

  getAnalysis(fileId: string): Promise<AnalysisResult | null>;
  putAnalysis(result: AnalysisResult): Promise<void>;

  getMetadata(fileId: string): Promise<TrackMetadata | null>;
  putMetadata(result: TrackMetadata): Promise<void>;

  /**
   * A URI ready to hand straight to an <Image source={{uri}}/> for the
   * cover art extracted alongside a track's metadata (see
   * ensureTrackMetadata) - null when the file has none, or hasn't been
   * scanned yet (indistinguishable here; see useCoverArt for how the UI
   * tells them apart). What kind of URI this actually is is up to the
   * adapter: a data: URI (Android/Windows, whose storage is text-based
   * anyway) or a blob: object URL (web, backed by a real Blob in
   * IndexedDB rather than a base64 string - cheaper to store and decode).
   */
  getCoverArt(fileId: string): Promise<string | null>;
  /** `art: null` clears any previously stored art (e.g. the file changed and no longer has any). Raw bytes, not a pre-encoded string - each adapter decides its own storage/URI representation (see getCoverArt). */
  putCoverArt(fileId: string, art: CoverArtBytes | null): Promise<void>;

  getPlaybackState(): Promise<PlaybackState | null>;
  putPlaybackState(state: PlaybackState): Promise<void>;
}
