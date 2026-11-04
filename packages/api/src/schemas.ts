import { z } from 'zod';

/**
 * The API version this build speaks, and the one a client sends. Bumped only for a breaking change - see
 * docs/api-compatibility.md before touching it (or anything else on the wire).
 */
export const API_VERSION = 1;
/**
 * The versions a server built from this code answers. Normally just [API_VERSION]; while a deprecation window is
 * open it also lists the previous version, so apps that haven't updated yet keep working.
 */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1];
/** Request header clients send with the version they speak. The server answers 426 when it can't serve that version. */
export const API_VERSION_HEADER = 'X-Beatseam-Api';
/** Response header on every /api/v1 answer: the versions the server speaks, comma-separated. Servers from before it existed omit it, and speak only version 1. */
export const API_VERSIONS_HEADER = 'X-Beatseam-Api-Versions';
/** The `code` of the 426 a server answers with when it doesn't speak the client's version. */
export const API_VERSION_UNSUPPORTED_CODE = 'api_version_unsupported';

export const rootSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  kind: z.enum(['library', 'lyrics']),
});
export type RootDto = z.infer<typeof rootSchema>;

export const trackSchema = z.object({
  /** Opaque key for URLs - see encodeTrackKey. */
  id: z.string(),
  rootId: z.string(),
  relativePath: z.string(),
  sizeBytes: z.number(),
  lastModifiedMs: z.number(),
  /** A playlist referenced this path but the file isn't on disk. */
  missing: z.boolean(),
  title: z.string().nullable(),
  artists: z.array(z.string()),
  album: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  /** sha256 (hex) of the file once scanned; lets a client verify a download or detect a changed file. */
  contentHash: z.string().nullable(),
  /** Linear gain that brings the track to the reference loudness, once analysed. */
  normalizationGain: z.number().nullable(),
  hasCover: z.boolean(),
  hasLyrics: z.boolean(),
});
export type TrackDto = z.infer<typeof trackSchema>;

export const playlistSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  name: z.string(),
  /** Track keys in play order (duplicates allowed). */
  trackIds: z.array(z.string()),
});
export type PlaylistDto = z.infer<typeof playlistSchema>;

/** A track's lyrics, parsed (and matched with its translation) by the server: same shape as the app's ParsedLyrics. */
export const lyricsSchema = z.object({
  /** At least one line has a timestamp; false means plain text, one line per entry. */
  synced: z.boolean(),
  tags: z.record(z.string(), z.string()),
  lines: z.array(z.object({ timeSeconds: z.number().nullable(), text: z.string(), translation: z.string().nullable().optional() })),
});
export type LyricsDto = z.infer<typeof lyricsSchema>;

/** A lyrics file the server found in its lyrics folders: what "Link a lyrics file" lets an admin choose from. */
export const lyricsFileSchema = z.object({ id: z.string(), name: z.string(), relativePath: z.string(), rootId: z.string() });
export type LyricsFileDto = z.infer<typeof lyricsFileSchema>;

/** Where a track's lyrics come from: the file assigned to it (null = none) and every file it could be assigned. */
export const lyricsSourceSchema = z.object({ assigned: z.string().nullable(), candidates: z.array(lyricsFileSchema) });
export type LyricsSourceDto = z.infer<typeof lyricsSourceSchema>;

export const lyricsAssignRequestSchema = z.object({ lrcFileId: z.string().min(1).max(2048).nullable() });

/** "These lyrics are wrong": any signed-in user can flag a track's lyrics for an admin to look at. */
export const lyricsReportRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type LyricsReportRequestDto = z.infer<typeof lyricsReportRequestSchema>;

export const lyricsReportSchema = z.object({
  id: z.string(),
  /** The track's key, as the other routes take it. */
  trackId: z.string(),
  /** Where the track was when it was reported (it may be gone since). */
  relativePath: z.string(),
  reportedBy: z.string(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type LyricsReportDto = z.infer<typeof lyricsReportSchema>;
export const lyricsReportListSchema = z.array(lyricsReportSchema);

export const MAX_LYRICS_LINES = 5000;
/** The lines of a hand-synced or hand-edited lyrics file, written back to the track's assigned .lrc. */
export const lyricsSaveRequestSchema = z.object({
  lines: z
    .array(z.object({ timeSeconds: z.number().min(0).max(86_400).nullable(), text: z.string().max(2000) }))
    .max(MAX_LYRICS_LINES),
});
export type LyricsSaveRequestDto = z.infer<typeof lyricsSaveRequestSchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export type Page<T> = { items: T[]; nextCursor: string | null };

export const MAX_PAGE_SIZE = 500;

export const listTracksQuerySchema = z.object({
  rootId: z.string().optional(),
  /** Case-insensitive match against title, artist, album and path. */
  q: z.string().trim().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
});
export type ListTracksQuery = z.infer<typeof listTracksQuerySchema>;

export const jobCountsSchema = z.object({
  pending: z.number(),
  /** Pending jobs that already failed once and are waiting out their backoff (included in `pending`). */
  retrying: z.number(),
  running: z.number(),
  done: z.number(),
  /** Failed every attempt; left alone until the file changes or someone retries them. */
  skipped: z.number(),
});
export type JobCountsDto = z.infer<typeof jobCountsSchema>;

export const scanStatusSchema = z.object({
  running: z.boolean(),
  last: z
    .object({
      startedAtMs: z.number(),
      finishedAtMs: z.number(),
      roots: z.number(),
      tracks: z.number(),
      queued: z.number(),
      jobs: jobCountsSchema,
    })
    .nullable(),
  jobs: jobCountsSchema,
  workers: z.object({
    workers: z.number(),
    /** The counters below are since this server process started. */
    succeeded: z.number(),
    failedAttempts: z.number(),
    skipped: z.number(),
    inFlight: z.number(),
  }),
});
export type ScanStatusDto = z.infer<typeof scanStatusSchema>;

export const jobStateSchema = z.enum(['PENDING', 'RUNNING', 'DONE', 'SKIPPED']);
export type JobStateDto = z.infer<typeof jobStateSchema>;

export const scanJobSchema = z.object({
  trackId: z.string(),
  /** Null if the track has since been removed. */
  relativePath: z.string().nullable(),
  state: jobStateSchema,
  attempts: z.number(),
  lastError: z.string().nullable(),
  lastErrorStage: z.string().nullable(),
  skippedAtMs: z.number().nullable(),
  updatedAtMs: z.number(),
});
export type ScanJobDto = z.infer<typeof scanJobSchema>;

export const scanFailureSchema = z.object({
  id: z.number(),
  trackId: z.string(),
  relativePath: z.string().nullable(),
  stage: z.string(),
  attempt: z.number(),
  error: z.string(),
  willRetry: z.boolean(),
  workerId: z.string(),
  atMs: z.number(),
});
export type ScanFailureDto = z.infer<typeof scanFailureSchema>;

export const listScanJobsQuerySchema = z.object({
  state: jobStateSchema.default('SKIPPED'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
});

export const listScanFailuresQuerySchema = z.object({
  /** Limit to one track (a track key). */
  trackId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
});
