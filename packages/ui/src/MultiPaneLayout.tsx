import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Colors } from './theme';
import type { ViewportTier } from './useViewportTier';

export interface MultiPaneLayoutProps {
  /** Never called with 'narrow' - that tier keeps today's single-screen-plus-overlay behavior in each App.tsx instead of using this component at all. */
  tier: Exclude<ViewportTier, 'narrow'>;
  /** Only used for the 'wide'-tier placeholder text shown in the playlist pane's reserved space when no playlist is open - see playlistPane's own doc. */
  colors: Colors;
  /** Always present - the library list. Only actually shown as its own pane on the 'wide' tier (see below); folded into the single left pane on 'medium'. */
  libraryPane: ReactNode;
  /**
   * The open playlist's track list, or null when no playlist is open
   * (screen.kind === 'library' in both App.tsx files). On the 'wide' tier
   * this pane's space is reserved either way (see below) - only its
   * *content* switches between this and a placeholder, so opening/closing
   * a playlist there never resizes the library/Now Playing panes next to
   * it. On 'medium' this still folds away entirely when null, same as
   * before, since there's only one non-Now-Playing pane to begin with.
   */
  playlistPane: ReactNode | null;
  /**
   * The docked Now Playing pane - always present now, even with nothing
   * loaded (playerState.currentFileId null), so volume/loop/shuffle stay
   * reachable on the medium/wide tiers without ever having played a track.
   * Still typed as nullable since a caller could reasonably omit it.
   */
  nowPlayingPane: ReactNode | null;
}

/**
 * Renders 2-3 side-by-side panes for the medium/wide viewport tiers (see
 * useViewportTier) - the shared piece of "on larger viewports the playlist
 * and now playing views should appear side-by-side... on the largest screen
 * sizes even the library view can be shown" (CLAUDE.md's UI/UX TODO this
 * implements). Used identically from apps/web/src/App.tsx and
 * apps/mobile/App.tsx per this repo's platform-parity convention - the
 * pane *content* (LibraryScreen/TrackList/NowPlayingScreen elements) is
 * still built per-app since it threads through app-specific handlers, but
 * the arrangement logic lives here once.
 *
 * - medium: one pane (playlistPane if open, else libraryPane) + a docked
 *   Now Playing pane. This matches the narrow tier's single
 *   library-or-playlist screen, just with Now Playing docked alongside it
 *   instead of a full-screen overlay you have to open/close.
 * - wide: libraryPane always shown as its own pane, and a playlist pane
 *   always reserves the same space alongside it - showing playlistPane's
 *   content when a playlist is open, else a placeholder - plus a docked
 *   Now Playing pane, three panes at once. Reserving the space (rather
 *   than omitting the pane when playlistPane is null, as a straight port
 *   of the narrow/medium "just don't render it" approach would) keeps
 *   opening/closing a playlist from resizing the library and Now Playing
 *   panes out from under the user, which read as the layout twitching
 *   every time - there was nowhere to "go back" to that wasn't already
 *   sitting right there, so the resize was the only visible effect closing
 *   the playlist actually had.
 */
export function MultiPaneLayout({ tier, colors, libraryPane, playlistPane, nowPlayingPane }: MultiPaneLayoutProps) {
  const panes: ReactNode[] = [];
  if (tier === 'wide') {
    panes.push(
      <View key="library" style={styles.pane}>
        {libraryPane}
      </View>,
    );
    panes.push(
      <View key="playlist" style={[styles.pane, styles.paneDivider]}>
        {playlistPane ?? <Text style={[styles.placeholder, { color: colors.subtleText }]}>Select a playlist to view its tracks.</Text>}
      </View>,
    );
  } else {
    panes.push(
      <View key="primary" style={styles.pane}>
        {playlistPane ?? libraryPane}
      </View>,
    );
  }
  if (nowPlayingPane) {
    panes.push(
      <View key="now-playing" style={[styles.pane, styles.paneDivider]}>
        {nowPlayingPane}
      </View>,
    );
  }
  return <View style={styles.row}>{panes}</View>;
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: 'row',
    width: '100%',
  },
  // alignItems: 'center' matters once a pane is wider than its content's own
  // maxWidth:480 cap (TrackList, LibraryScreen's list, ...) - without it the
  // capped content sits flush against the pane's left edge instead of
  // centered, leaving dead space on the right and a scrollbar that looks
  // stranded partway across the pane instead of at its true edge.
  pane: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    alignItems: 'center',
  },
  paneDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(128,128,128,0.3)',
  },
  placeholder: {
    marginTop: 24,
    maxWidth: 320,
    textAlign: 'center',
    opacity: 0.6,
  },
});
