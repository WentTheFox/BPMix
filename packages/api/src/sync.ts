import { z } from 'zod';
import { playlistSchema, rootSchema, trackSchema, MAX_PAGE_SIZE } from './schemas';

/**
 * Sync is a check-in, not a connection: the client remembers a cursor, asks for what changed since,
 * applies it, and stores the new cursor. Every change carries the entity's *current* state (or null
 * if it no longer exists), so applying one is an idempotent upsert-or-delete and a repeated or
 * out-of-order delivery of the same entity can't corrupt anything.
 */
export const syncChangeSchema = z.discriminatedUnion('entity', [
  /** A library track, with its tags, analysis and flags. `track: null` means it was removed. */
  z.object({ entity: z.literal('track'), id: z.string(), track: trackSchema.nullable() }),
  /** A shared (m3u8-backed) library playlist. */
  z.object({ entity: z.literal('playlist'), id: z.string(), playlist: playlistSchema.nullable() }),
]);
export type SyncChangeDto = z.infer<typeof syncChangeSchema>;

export const syncChangesResponseSchema = z.object({
  changes: z.array(syncChangeSchema),
  /** Opaque revision to send as `since` next time. Always store it, even when `changes` is empty. */
  cursor: z.string(),
  /** More changes are waiting beyond this page: call again with `cursor` straight away. */
  hasMore: z.boolean(),
  /** Library roots (tiny, so sent with every check-in rather than tracked by revision). */
  roots: z.array(rootSchema),
});
export type SyncChangesResponseDto = z.infer<typeof syncChangesResponseSchema>;

export const syncChangesQuerySchema = z.object({
  /** The cursor from the previous response. */
  since: z.string().regex(/^\d+$/),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(500),
});

export const syncSnapshotQuerySchema = z.object({
  /** The `next` value from the previous page; omit for the first page. */
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(500),
});

export const syncSnapshotResponseSchema = z.object({
  /** Every entity that exists, as upserts. */
  entities: z.array(syncChangeSchema),
  /** Pass as `after` for the next page; null when this was the last. */
  next: z.string().nullable(),
  /**
   * The revision to start `changes` from once the snapshot is complete. Take it from the FIRST
   * page: anything that changes while the snapshot is still being fetched is then picked up by
   * the first `changes` call, so nothing is missed.
   */
  cursor: z.string(),
  roots: z.array(rootSchema),
});
export type SyncSnapshotResponseDto = z.infer<typeof syncSnapshotResponseSchema>;

/** Body of the 410 answer: the cursor is too old (history was trimmed) or unknown; fetch a snapshot instead. */
export const resyncRequiredSchema = z.object({ code: z.literal('resync_required'), message: z.string() });
