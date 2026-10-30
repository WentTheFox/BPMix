import { encodeTrackKey } from '@bpmix/api';
import type { LibraryStore, PlaylistRecord } from '../library-store/types';
import { USER_PLAYLIST_ID_PREFIX } from './applySync';
import type { ServerMode } from './serverMode';
import { randomId } from './randomId';

export interface UserPlaylistDeps {
  store: LibraryStore;
  serverMode: Pick<ServerMode, 'roots' | 'mutations'>;
}

/** Whether a local playlist id is one the user built in the app (editable), as opposed to a library `.m3u8` (the server's). */
export const isUserPlaylistId = (id: string): boolean => id.startsWith(USER_PLAYLIST_ID_PREFIX);

const serverIdOf = (localId: string) => localId.slice(USER_PLAYLIST_ID_PREFIX.length);
const keysOf = (fileIds: readonly string[]) => fileIds.map(encodeTrackKey);
const unique = (ids: readonly string[]) => [...new Set(ids)];

async function find(store: LibraryStore, id: string): Promise<PlaylistRecord> {
  const found = (await store.listAllPlaylists()).find((p) => p.id === id);
  if (!found) throw new Error('That playlist no longer exists');
  return found;
}

/**
 * Edits to a user's own playlists. Each applies to the local library at once (so the screen reflects
 * it with no waiting, and the app works offline) and is queued for the server; the next check-in
 * brings back the server's version of the result, which is what the other devices see too.
 */
export async function createUserPlaylist(deps: UserPlaylistDeps, name: string, fileIds: readonly string[] = []): Promise<PlaylistRecord> {
  const rootId = deps.serverMode.roots()[0]?.id;
  if (!rootId) throw new Error('Sync with the server before creating a playlist');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Give the playlist a name');
  const serverId = randomId();
  const id = `${USER_PLAYLIST_ID_PREFIX}${serverId}`;
  const record: PlaylistRecord = { id, rootId, fileId: id, name: trimmed.slice(0, 200), trackFileIds: [...fileIds] };
  await deps.store.upsertPlaylist(record);
  await deps.serverMode.mutations.enqueue({ type: 'playlist.create', id: serverId, name: record.name, trackIds: keysOf(fileIds) });
  return record;
}

/** Adds tracks that aren't already in the playlist, at the end or the start. */
export async function addToUserPlaylist(deps: UserPlaylistDeps, id: string, fileIds: readonly string[], position: 'start' | 'end' = 'end'): Promise<PlaylistRecord> {
  const playlist = await find(deps.store, id);
  const present = new Set(playlist.trackFileIds);
  const additions = unique(fileIds).filter((f) => !present.has(f));
  if (additions.length === 0) return playlist;
  const trackFileIds = position === 'end' ? [...playlist.trackFileIds, ...additions] : [...additions, ...playlist.trackFileIds];
  const updated = { ...playlist, trackFileIds };
  await deps.store.upsertPlaylist(updated);
  // Adding at the end is a set-like operation that merges with another device's edits; the start has no such
  // operation, so it replaces the order (the last writer wins).
  if (position === 'end') await deps.serverMode.mutations.enqueue({ type: 'playlist.addTracks', id: serverIdOf(id), trackIds: keysOf(additions) });
  else await deps.serverMode.mutations.enqueue({ type: 'playlist.setTracks', id: serverIdOf(id), trackIds: keysOf(trackFileIds) });
  return updated;
}

export async function removeFromUserPlaylist(deps: UserPlaylistDeps, id: string, fileIds: readonly string[]): Promise<PlaylistRecord> {
  const playlist = await find(deps.store, id);
  const removing = new Set(fileIds);
  const updated = { ...playlist, trackFileIds: playlist.trackFileIds.filter((f) => !removing.has(f)) };
  await deps.store.upsertPlaylist(updated);
  await deps.serverMode.mutations.enqueue({ type: 'playlist.removeTracks', id: serverIdOf(id), trackIds: keysOf(fileIds) });
  return updated;
}

/** Replaces the order (a reorder). */
export async function setUserPlaylistTracks(deps: UserPlaylistDeps, id: string, fileIds: readonly string[]): Promise<PlaylistRecord> {
  const playlist = await find(deps.store, id);
  const updated = { ...playlist, trackFileIds: [...fileIds] };
  await deps.store.upsertPlaylist(updated);
  await deps.serverMode.mutations.enqueue({ type: 'playlist.setTracks', id: serverIdOf(id), trackIds: keysOf(fileIds) });
  return updated;
}

export async function renameUserPlaylist(deps: UserPlaylistDeps, id: string, name: string): Promise<PlaylistRecord> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Give the playlist a name');
  const playlist = await find(deps.store, id);
  const updated = { ...playlist, name: trimmed.slice(0, 200) };
  await deps.store.upsertPlaylist(updated);
  await deps.serverMode.mutations.enqueue({ type: 'playlist.rename', id: serverIdOf(id), name: updated.name });
  return updated;
}

export async function deleteUserPlaylist(deps: UserPlaylistDeps, id: string): Promise<void> {
  await deps.store.deletePlaylist(id);
  await deps.serverMode.mutations.enqueue({ type: 'playlist.delete', id: serverIdOf(id) });
}
