import type { FileAccess, GrantedRoot } from '../file-access/types';
import type { LibraryStore, PlaylistRecord, TrackRecord } from '../library-store/types';
import { scanRoot } from './scan';

export interface LoadedRoot {
  root: GrantedRoot;
  playlists: PlaylistRecord[];
  tracksById: Map<string, TrackRecord>;
}

/**
 * Loads one granted root's playlists/tracks from the store, scanning it
 * first if the store has nothing for it yet - a root can reach
 * listGrantedRoots() without ever going through addFolder's explicit
 * requestRoot+scanRoot flow (e.g. a composite-adapter root the self-hosted
 * server exposes just by having a volume mounted), so this covers that case
 * the same way both apps' refresh() already did inline.
 *
 * Extracted out of both apps' refresh() so the per-root logic can't drift
 * between them, and so the startup restore path (usePlaybackPersistence)
 * can load just the one root it needs to resume playback without pulling in
 * every other granted root first - see CLAUDE.md's note on that path.
 */
export interface LoadRootLibraryOptions {
  /**
   * Scan the root's folders when nothing is stored for it yet (the default). Off when the library
   * comes from a server: there are no folders to walk, and the sync fills the store instead.
   */
  scanIfEmpty?: boolean;
}

export async function loadRootLibrary(fileAccess: FileAccess, store: LibraryStore, root: GrantedRoot, options: LoadRootLibraryOptions = {}): Promise<LoadedRoot> {
  let [playlists, tracks] = await Promise.all([store.listPlaylists(root.id), store.listTracks(root.id)]);
  if (playlists.length === 0 && tracks.length === 0 && (options.scanIfEmpty ?? true)) {
    await scanRoot(fileAccess, store, root.id);
    [playlists, tracks] = await Promise.all([store.listPlaylists(root.id), store.listTracks(root.id)]);
  }
  return { root, playlists, tracksById: new Map(tracks.map((t) => [t.fileId, t])) };
}
