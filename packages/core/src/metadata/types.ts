/** Raw cover art bytes, not yet turned into any particular storage/display representation - each platform's LibraryStore adapter decides how to persist this and what kind of URI to hand back from getCoverArt (a data: URI on Android/Windows, a blob: object URL on web - see libraryStore.ts's putCoverArt/getCoverArt). */
export interface CoverArtBytes {
  mimeType: string;
  data: Uint8Array;
}

/** ID3 (or other tag format) metadata read out of an audio file, tied to the file it was read from. */
export interface TrackMetadata {
  fileId: string;
  title: string | null;
  /** Multiple artists as stored (e.g. ID3v2.4's null-separated TPE1, or v2.3's "/"-separated form) split into individual names; empty when the file has no artist tag. */
  artists: string[];
  album: string | null;
  /** Seconds, parsed from the audio container's own header (FLAC STREAMINFO, MP4 mvhd, MP3 Xing/VBRI or a bitrate estimate - see parseDuration.ts) rather than an ID3 tag (unreliable - the optional TLEN frame is rarely set) or a full decode (too expensive to do for every track in a background scan). Null for a format parseDuration.ts doesn't cover (OGG/Opus/WMA - their duration lives at the end of the file) or one it couldn't confidently parse. */
  durationSeconds: number | null;
  /**
   * The TrackRecord's sizeBytes/lastModifiedMs at the time metadata was
   * read - same freshness-check role as AnalysisResult's fields (see its
   * doc comment): a file edited in place keeps the same fileId, so these
   * are what actually catch a changed file.
   */
  sizeBytes: number;
  lastModifiedMs: number;
  /** METADATA_PARSER_VERSION at read time - a mismatch means the parser changed since, so the result is stale even though the file itself didn't. */
  parserVersion: number;
  /**
   * A real content hash of the file at read time - FNV-1a of the full
   * bytes (contentHash.ts) for a platform that reads them directly, or a
   * server-computed sha256 for fileAccess.server.ts's streamUrl path (see
   * FileAccess.getContentHash's doc - the server hashes its own local disk
   * copy, so the client never downloads the file just for this). The two
   * algorithms differing is fine: this is only ever compared against a
   * prior value from the same adapter for the same file, never across
   * adapters. Null only if an adapter implements neither path (none
   * currently do).
   *
   * sizeBytes/lastModifiedMs are what isMetadataFresh actually gates a
   * re-read on (see that function's doc) - a hash can't do that job
   * itself, since computing one requires reading the file, which is
   * exactly the read a freshness check exists to avoid for an unchanged
   * file. This field exists for the case that check can't catch: a file
   * whose content changed but whose size and mtime happen not to (a sync
   * tool that preserves timestamps, e.g.) - passing forceRefresh to
   * ensureTrackMetadata bypasses isMetadataFresh and re-derives this,
   * which is how that gets caught, not automatic background detection.
   */
  contentHash: string | null;
}
