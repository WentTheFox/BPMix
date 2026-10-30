import { z } from 'zod';

/** Bumped only for breaking changes; additive changes stay within the same version. */
export const API_VERSION = 1;
/** Request header clients send; the server answers 426 when it can't serve that version. */
export const API_VERSION_HEADER = 'X-BPMix-Api';

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
