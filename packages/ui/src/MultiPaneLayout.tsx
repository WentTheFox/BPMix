import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ViewportTier } from './useViewportTier';

export interface MultiPaneLayoutProps {
  /** Never called with 'narrow' - that tier keeps today's single-screen-plus-overlay behavior in each App.tsx instead of using this component at all. */
  tier: Exclude<ViewportTier, 'narrow'>;
  /** Always present - the library list. Only actually shown as its own pane on the 'wide' tier (see below); folded into the single left pane on 'medium'. */
  libraryPane: ReactNode;
  /** The open playlist's track list, or null when no playlist is open (screen.kind === 'library' in both App.tsx files). */
  playlistPane: ReactNode | null;
  /** The docked Now Playing pane, or null when nothing's loaded (playerState.currentFileId is null) - there's nothing to dock in that case. */
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
 *   Now Playing pane when present. This matches the narrow tier's single
 *   library-or-playlist screen, just with Now Playing docked alongside it
 *   instead of a full-screen overlay you have to open/close.
 * - wide: libraryPane always shown as its own pane, playlistPane added
 *   alongside it when a playlist is open, and a docked Now Playing pane
 *   added when present - up to three panes at once.
 */
export function MultiPaneLayout({ tier, libraryPane, playlistPane, nowPlayingPane }: MultiPaneLayoutProps) {
  const panes: ReactNode[] = [];
  if (tier === 'wide') {
    panes.push(
      <View key="library" style={styles.pane}>
        {libraryPane}
      </View>,
    );
    if (playlistPane) {
      panes.push(
        <View key="playlist" style={[styles.pane, styles.paneDivider]}>
          {playlistPane}
        </View>,
      );
    }
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
  pane: {
    flex: 1,
    minWidth: 0,
    height: '100%',
  },
  paneDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(128,128,128,0.3)',
  },
});
