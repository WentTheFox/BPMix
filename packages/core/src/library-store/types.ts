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

export interface WindowAnalysis {
  bpm: number;
  bpmConfidence: number;
  /**
   * Absolute position (seconds from the very start of the track, sample 0 -
   * not relative to the analysis window) of a beat that lines up with the
   * detected tempo within this window. A transition needs to know where a
   * beat actually falls, not just how far apart beats are - bpm alone can't
   * answer "where do I cut from/into this track."
   */
  beatAnchorSeconds: number;
}

export interface AnalysisResult {
  fileId: string;
  /** BPM/beat-grid analysis of the track's opening (post-leading-silence-trim) - the "incoming" side of a transition. */
  startWindow: WindowAnalysis;
  /** BPM/beat-grid analysis of the track's ending (pre-trailing-silence-trim) - the "outgoing" side of a transition. */
  endWindow: WindowAnalysis;
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
}

export interface LibraryStore {
  upsertTrack(track: TrackRecord): Promise<void>;
  upsertPlaylist(playlist: PlaylistRecord): Promise<void>;
  listTracks(rootId: string): Promise<TrackRecord[]>;
  listPlaylists(rootId: string): Promise<PlaylistRecord[]>;

  getAnalysis(fileId: string): Promise<AnalysisResult | null>;
  putAnalysis(result: AnalysisResult): Promise<void>;

  getPlaybackState(): Promise<PlaybackState | null>;
  putPlaybackState(state: PlaybackState): Promise<void>;
}
