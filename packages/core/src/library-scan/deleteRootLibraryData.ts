import type { LibraryStore } from '../library-store/types';

/**
 * Deletes every track and playlist row LibraryStore holds for a root -
 * paired with FileAccess.revokeRoot (see useLibraryRootActions.removeRoot)
 * so removing a root actually cleans up after itself, rather than
 * revoking the OS-level grant while leaving all of that root's rows
 * behind forever (confirmed live: a root re-granted after its old access
 * lapsed left over a thousand orphaned track rows under the old grant,
 * invisible in the UI - no longer a listed root - but still sitting in
 * storage indefinitely).
 */
export async function deleteRootLibraryData(store: LibraryStore, rootId: string): Promise<void> {
  const [tracks, playlists] = await Promise.all([store.listTracks(rootId), store.listPlaylists(rootId)]);
  await Promise.all([...tracks.map((t) => store.deleteTrack(t.fileId)), ...playlists.map((p) => store.deletePlaylist(p.id))]);
}
