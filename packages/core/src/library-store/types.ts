import type { CoverArtBytes, TrackMetadata } from '../metadata/types';

export interface TrackRecord {
  /** Matches FileRef.id. For a missing track (see `missing` below) this is a synthetic id derived from rootId+relativePath instead - never a real FileRef.id, since no file exists to have one. */
  fileId: string;
  rootId: string;
  relativePath: string;
  sizeBytes: number;
  lastModifiedMs: number;
  /**
   * True for a placeholder standing in for a playlist entry that scanRoot
   * couldn't resolve to a real file (relativePath is the path it expected
   * to find, for display and for "locate this file" to search from) -
   * without this, an unresolved entry used to just silently vanish from the
   * playlist instead of showing up at all (see scan.ts's ScanResult.
   * unresolvedEntries, which this is built from). Never true for a track
   * that resolved fine at scan time and later failed to *decode* at play
   * time - that's a separate, playback-time-only condition surfaced via
   * TrackRow.isMissing/missingFileIds instead, not persisted here.
   */
  missing?: boolean;
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

/**
 * A folder to scan for .lrc lyrics files, expressed as a subfolder of an
 * ALREADY-granted root rather than a root of its own - `relativePath: ''`
 * means the whole root. This is deliberate: requesting a brand-new top-level
 * OS grant just for lyrics hit a real-world wall (a broken Samsung "My
 * Files" SAF picker rejected every folder, including freshly-created ones,
 * while the picker's own normal browse mode saw them fine) - scoping to a
 * subfolder of a root the user already granted for music sidesteps that
 * picker entirely, since listing within an existing grant never needed it
 * in the first place. See FolderBrowser (packages/ui) for how a user picks
 * the relativePath without any new OS-level prompt.
 */
export interface LyricsScope {
  rootId: string;
  relativePath: string;
}

export interface PlaybackState {
  /** The playlist the CURRENTLY PLAYING track belongs to - see openedPlaylistId's doc for why this is a separate field from "the playlist screen that's open". */
  playlistId: string | null;
  currentTrackFileId: string | null;
  /**
   * Which granted root playlistId belongs to - lets startup restore go
   * straight to the right root without checking every granted root first
   * (see loadRootLibrary/usePlaybackPersistence). `null` for state persisted
   * before this field existed, or if the root was somehow unknown at
   * persist time; restore falls back to a (still-cheap, no-scan) linear
   * search across granted roots' cached playlists in that case.
   */
  rootId: string | null;
  /**
   * The playlist screen the user last had OPEN, which may not be the same
   * playlist as `playlistId` (the one actually playing) - e.g. browsing
   * playlist B's track list while a track from playlist A keeps playing.
   * `null` means the user was explicitly on the Library screen (not any
   * playlist) when this was last persisted - restore then leaves `screen`
   * at its default `{ kind: 'library' }` instead of forcing the playing
   * playlist's screen open. `undefined` on read (state persisted before
   * this field existed) is treated the same as "not yet navigated away
   * from the playing playlist" and falls back to `playlistId` - see
   * usePlaybackPersistence's restore effect.
   */
  openedPlaylistId: string | null;
  /** Which granted root openedPlaylistId belongs to - same role/fallback as rootId, just for the opened screen instead of the playing track. */
  openedRootId: string | null;
  positionSeconds: number;
  loopMode: LoopMode;
  shuffleEnabled: boolean;
  /**
   * The shuffle order as fileIds (see PlaylistPlayer.getShuffleOrder), so a
   * relaunch resumes the exact same shuffled sequence instead of silently
   * re-shuffling every time shuffleEnabled is true. Null when shuffle is
   * off, or for state persisted before this field existed.
   */
  shuffleOrder: string[] | null;
  /** User-facing master volume [0,1] - see PlaylistPlayer.setVolume. Persisted so the next launch doesn't blast out at whatever volume happened to be in effect (e.g. full, its default) before it's set once. */
  volume: number;
  /** Whether the Now Playing screen (opened from the mini bar's art/title) was showing when last closed - restored so relaunching lands back on it instead of always the playlist/library screen underneath. */
  nowPlayingOpen: boolean;
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

  /** Every configured lyrics scope, across every root - see LyricsScope's doc. */
  getLyricsScopes(): Promise<LyricsScope[]>;
  /** No-ops if this exact (rootId, relativePath) pair is already present. */
  addLyricsScope(scope: LyricsScope): Promise<void>;
  removeLyricsScope(rootId: string, relativePath: string): Promise<void>;

  /** The .lrc file (FileRef.id, from a lyrics scope) assigned to this track - null if none. Set either by auto-match (see findAutoLyricsMatch) or a manual override; both go through this same call. */
  getLyricsAssignment(fileId: string): Promise<string | null>;
  putLyricsAssignment(fileId: string, lrcFileId: string | null): Promise<void>;

  /**
   * Generic string key-value storage for small, standalone bits of app
   * state that don't warrant their own dedicated store/table (e.g. the last
   * known lyrics-match count, used to show an optimistic total on next
   * launch instead of an empty/zero display while the background match
   * pass re-verifies it - see matchLibraryLyrics). Caller-side
   * JSON.stringify/parse for anything structured; kept to strings here so
   * every adapter (SQLite, IndexedDB, a plain JSON blob) can store it
   * identically without a schema per key.
   */
  getSetting(key: string): Promise<string | null>;
  putSetting(key: string, value: string): Promise<void>;
}
