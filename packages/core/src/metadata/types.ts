/** ID3 (or other tag format) metadata read out of an audio file, tied to the file it was read from. */
export interface TrackMetadata {
  fileId: string;
  title: string | null;
  /** Multiple artists as stored (e.g. ID3v2.4's null-separated TPE1, or v2.3's "/"-separated form) split into individual names; empty when the file has no artist tag. */
  artists: string[];
  album: string | null;
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
}
