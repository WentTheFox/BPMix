import type { LibraryStore } from '../library-store/types';
import { deleteRootLibraryData } from './deleteRootLibraryData';

/**
 * Deletes LibraryStore data for any rootId that isn't in `grantedRootIds` -
 * self-heals installs that predate deleteRootLibraryData being wired into
 * useLibraryRootActions.removeRoot (before that, revoking a root's OS-level
 * grant left all of its track/playlist rows behind forever, invisible in the
 * UI but still inflating library-wide counts indefinitely - confirmed live:
 * a root re-granted after its old access lapsed left over a thousand
 * orphaned rows under the old grant). Meant to run as idle/background
 * startup work (see refresh() in both App.tsx files), never on the
 * latency-sensitive restore path - a full listAllTracks()/listAllPlaylists()
 * scan is the same cost class as a library-wide rescan, not something
 * RestoringScreen should wait on.
 *
 * Returns the pruned rootIds, for logging.
 */
export async function pruneOrphanedRootData(store: LibraryStore, grantedRootIds: readonly string[]): Promise<string[]> {
  const granted = new Set(grantedRootIds);
  const [tracks, playlists] = await Promise.all([store.listAllTracks(), store.listAllPlaylists()]);

  const presentRootIds = new Set<string>();
  for (const track of tracks) presentRootIds.add(track.rootId);
  for (const playlist of playlists) presentRootIds.add(playlist.rootId);

  const orphanedRootIds = [...presentRootIds].filter((rootId) => !granted.has(rootId));
  await Promise.all(orphanedRootIds.map((rootId) => deleteRootLibraryData(store, rootId)));
  return orphanedRootIds;
}
