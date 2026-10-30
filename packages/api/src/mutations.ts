import { z } from 'zod';

/**
 * Changes a client makes while offline are queued and sent here later. Each carries a client-chosen
 * `opId`, so a retry after a dropped connection is recognised and not applied twice; each is applied
 * on its own, in order.
 *
 * Merge rules, so two devices editing offline converge instead of fighting:
 *  - adding/removing tracks are set-like (adding something already there, or removing something
 *    already gone, is a no-op), so concurrent adds and removes combine;
 *  - renaming, replacing a track list, settings and playback state are last-write-wins by the order
 *    the server receives them.
 */
const opId = z.string().min(8).max(64);
const playlistId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const trackKeys = z.array(z.string().min(1).max(2048)).max(10_000);
const playlistName = z.string().trim().min(1).max(200);
const settingKey = z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/);

export const MAX_PLAYBACK_STATE_BYTES = 256 * 1024;
export const MAX_SETTING_VALUE_BYTES = 16 * 1024;
export const MAX_MUTATIONS_PER_REQUEST = 100;

export const mutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('playlist.create'), opId, id: playlistId, name: playlistName, trackIds: trackKeys.default([]) }),
  z.object({ type: z.literal('playlist.rename'), opId, id: playlistId, name: playlistName }),
  z.object({ type: z.literal('playlist.delete'), opId, id: playlistId }),
  z.object({ type: z.literal('playlist.addTracks'), opId, id: playlistId, trackIds: trackKeys }),
  z.object({ type: z.literal('playlist.removeTracks'), opId, id: playlistId, trackIds: trackKeys }),
  z.object({ type: z.literal('playlist.setTracks'), opId, id: playlistId, trackIds: trackKeys }),
  z.object({ type: z.literal('playbackState.set'), opId, deviceId: z.string().min(1).max(64), state: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('setting.set'), opId, key: settingKey, value: z.string() }),
  z.object({ type: z.literal('setting.delete'), opId, key: settingKey }),
]);
export type MutationDto = z.infer<typeof mutationSchema>;

export const mutationsRequestSchema = z.object({ mutations: z.array(mutationSchema).min(1).max(MAX_MUTATIONS_PER_REQUEST) });

export const mutationResultSchema = z.object({
  opId: z.string(),
  /**
   * applied: done. duplicate: this opId was already applied (safe to drop from the queue).
   * rejected: will never succeed (not yours, too large, no such playlist) - drop it and tell the user.
   */
  status: z.enum(['applied', 'duplicate', 'rejected']),
  error: z.string().optional(),
});
export type MutationResultDto = z.infer<typeof mutationResultSchema>;

export const mutationsResponseSchema = z.object({ results: z.array(mutationResultSchema) });
export type MutationsResponseDto = z.infer<typeof mutationsResponseSchema>;
