import type { GrantedRoot } from '../../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../../library-store/types';

/** A granted library root with its scanned playlists and tracks, `tracksById` as the Map the UI looks tracks up in. Derived from the serializable LibraryRootData by selectRootsWithLibrary. */
export interface RootWithLibrary {
  root: GrantedRoot;
  playlists: PlaylistRecord[];
  tracksById: Map<string, TrackRecord>;
}

/** The serializable form held in state - tracks as an array, since a Map can't live in the store. */
export interface LibraryRootData {
  root: GrantedRoot;
  playlists: PlaylistRecord[];
  tracks: TrackRecord[];
}
