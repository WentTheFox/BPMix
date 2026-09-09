import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';

export interface HeaderRowProps {
  /** The screen's own title/back-button content - left-aligned (previously centered as the sole child of a narrower, center-aligned screen container). */
  left: ReactNode;
  /** Typically the NotificationBell - right-aligned in the same row so it never floats over content below it. */
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Shared header-row layout: left content, optional right-aligned accessory,
 * both vertically centered - used by LibraryScreen's title row, the
 * playlist screen's back row, and NowPlayingScreen's back row, so
 * NotificationBell has exactly one place to sit on every screen instead of
 * floating as a separate absolutely-positioned overlay (which used to cover
 * whatever content happened to be underneath it).
 */
export function HeaderRow({ left, right, style }: HeaderRowProps) {
  return (
    <View style={[styles.row, style]}>
      <View style={styles.left}>{left}</View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 12,
    // Baked in here rather than left to each caller's own `style` override -
    // LibraryScreen's HeaderRow call had none at all while the playlist
    // screen (both apps) and NowPlayingScreen each separately added their
    // own slightly different value (paddingTop: 8 vs paddingVertical: 12),
    // so the three screens' header rows sat at three different vertical
    // offsets - visible on-device as two overlapping header rows/bells
    // that were also offset from each other, not just stacked. A caller's
    // own `style` can still override this if a screen genuinely needs to.
    paddingVertical: 12,
    // position+zIndex here, not just on NotificationBell's own overlay -
    // confirmed live (via document.elementFromPoint, real hit-testing, not
    // just a screenshot glance) that a high z-index nested deep inside this
    // row's `right` slot never helped: it only wins among ITS OWN siblings
    // within this row, it doesn't propagate up to make this ROW outrank
    // whatever sibling sits below it on the screen (TrackList, LibraryScreen's
    // FlatList) at THEIR shared parent - those siblings had no explicit
    // z-index of their own either (defaulting to 0, same as this row), so
    // the tie was won by DOM order instead - the row below always paints
    // after this header, so it always won. This row needs its own elevation
    // so any absolutely-positioned overlay inside it (the notification
    // panel, today) can reliably float above whatever's below it.
    position: 'relative',
    zIndex: 1,
  },
  left: {
    flexShrink: 1,
    minWidth: 0,
  },
});
