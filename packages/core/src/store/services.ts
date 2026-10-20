import type { AppUpdateNativeBridge } from '../appUpdate/nativeBridge';
import type { AudioEngine } from '../audio-engine/types';
import type { DiscordPresenceBridge } from '../discord/richPresence';
import type { FileAccess } from '../file-access/types';
import type { LibraryStore } from '../library-store/types';
import type { CoverArtResizer } from '../metadata/coverArtResizer';
import type { PlaylistPlayer } from '../playback/playlistPlayer';

/**
 * Everything with a side effect that thunks and listeners may reach. Passed
 * as redux-thunk's `extraArgument`, so slices and reducers stay pure and
 * tests swap in fakes. Each app builds the real one at module scope (the
 * same place it already creates these adapters today).
 *
 * A `null` bridge means "feature absent on this platform", same convention
 * the App.tsx files use today.
 */
export interface Services {
  fileAccess: FileAccess;
  libraryStore: LibraryStore;
  audioEngine: AudioEngine;
  playlistPlayer: PlaylistPlayer;
  coverArtResizer: CoverArtResizer;
  appUpdateBridge: AppUpdateNativeBridge | null;
  discordPresenceBridge: DiscordPresenceBridge | null;
  now: () => number;
}
