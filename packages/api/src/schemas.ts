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

export const scanStatusSchema = z.object({
  running: z.boolean(),
  last: z
    .object({
      startedAtMs: z.number(),
      finishedAtMs: z.number(),
      roots: z.number(),
      tracks: z.number(),
      metadataFailures: z.number(),
      analysisFailures: z.number(),
    })
    .nullable(),
});
export type ScanStatusDto = z.infer<typeof scanStatusSchema>;
