export interface BackNavigationState {
  settingsOpen: boolean;
  nowPlayingOpen: boolean;
  screenKind: 'library' | 'playlist';
}

export interface BackNavigationActions {
  closeSettings: () => void;
  closeNowPlaying: () => void;
  closePlaylist: () => void;
}

/**
 * The single priority order a back press (Android's hardware back button, or
 * the browser's back button on web - see useBackNavigation.ts/.web.ts) walks
 * through: Settings, then Now Playing, then Playlist back to Library. Both
 * apps call this same function so the two platforms can't drift apart on
 * which overlay closes first when more than one happens to be open at once.
 * Returns true if it closed something, false if the caller was already on
 * Library (the app's start screen) with nothing else open - the caller
 * should fall through to its platform's own default back behavior then
 * (exiting the app on mobile, leaving the page on web).
 */
export function handleBackNavigation(state: BackNavigationState, actions: BackNavigationActions): boolean {
  if (state.settingsOpen) {
    actions.closeSettings();
    return true;
  }
  if (state.nowPlayingOpen) {
    actions.closeNowPlaying();
    return true;
  }
  if (state.screenKind === 'playlist') {
    actions.closePlaylist();
    return true;
  }
  return false;
}
