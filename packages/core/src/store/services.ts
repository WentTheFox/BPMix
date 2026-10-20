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
  /**
   * File access for work with no user gesture behind it (startup refresh,
   * background scans), which must never trigger a permission prompt. The
   * same object as `fileAccess` on platforms without that permission model.
   */
  backgroundFileAccess: FileAccess;
  /** Roots that refresh always rescans, not just when their cache is empty (the self-hosted server's: its files change on disk with no app interaction). Always false where there are none. */
  alwaysRescanRoot: (rootId: string) => boolean;
  libraryStore: LibraryStore;
  audioEngine: AudioEngine;
  playlistPlayer: PlaylistPlayer;
  coverArtResizer: CoverArtResizer;
  appUpdateBridge: AppUpdateNativeBridge | null;
  discordPresenceBridge: DiscordPresenceBridge | null;
  now: () => number;
}
