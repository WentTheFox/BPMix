import { z } from 'zod';

/** Where one user's Last.fm link stands. The server holds the app credentials and the session; the app never sees either. */
export const lastFmStatusSchema = z.object({ connected: z.boolean(), username: z.string().nullable() });
export type LastFmStatusDto = z.infer<typeof lastFmStatusSchema>;

/** Step 1 of connecting: open this page in a browser and approve BPMix, then ask the server to complete. */
export const lastFmConnectResultSchema = z.object({ authUrl: z.string() });
export type LastFmConnectResultDto = z.infer<typeof lastFmConnectResultSchema>;

const text = z.string().min(1).max(500);

export const lastFmNowPlayingRequestSchema = z.object({
  artist: text,
  track: text,
  album: z.string().max(500).nullable().optional(),
  durationSeconds: z.number().min(0).max(86_400).nullable().optional(),
});
export type LastFmNowPlayingRequestDto = z.infer<typeof lastFmNowPlayingRequestSchema>;

export const lastFmScrobbleEntrySchema = z.object({
  artist: text,
  track: text,
  /** Unix seconds the track STARTED playing. */
  timestamp: z.number().int().positive(),
  album: z.string().max(500).nullable(),
  durationSeconds: z.number().min(0).max(86_400).nullable(),
});
export type LastFmScrobbleEntryDto = z.infer<typeof lastFmScrobbleEntrySchema>;

/** Last.fm takes at most 50 per call. */
export const MAX_SCROBBLES_PER_REQUEST = 50;
export const lastFmScrobblesRequestSchema = z.object({ entries: z.array(lastFmScrobbleEntrySchema).min(1).max(MAX_SCROBBLES_PER_REQUEST) });
export type LastFmScrobblesRequestDto = z.infer<typeof lastFmScrobblesRequestSchema>;
