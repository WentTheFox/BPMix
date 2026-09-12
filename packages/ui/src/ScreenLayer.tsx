import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Colors } from './theme';

export interface ScreenLayerProps {
  zIndex: number;
  colors: Colors;
  /** Mobile passes its safe-area inset here (`insets.top`/`insets.bottom`); web has no such concept and omits it. */
  paddingTop?: number;
  paddingBottom?: number;
  children: ReactNode;
}

/**
 * Full-screen absoluteFill overlay wrapper - identical between
 * apps/mobile/App.tsx and apps/web/src/App.tsx (Now Playing at zIndex 10,
 * Settings at zIndex 20) before this extraction, aside from mobile's extra
 * safe-area padding.
 *
 * zIndex here has to win over a nested descendant's own zIndex-less
 * content on this RN/Fabric version - confirmed on-device as two
 * overlapping header rows/bells ("Playlist: In Order" bleeding through
 * "Now Playing"'s own header) before this wrapper had its own zIndex, so
 * don't drop it even though it looks redundant with each screen's own
 * internal stacking.
 */
export function ScreenLayer({ zIndex, colors, paddingTop, paddingBottom, children }: ScreenLayerProps) {
  return <View style={[StyleSheet.absoluteFill, { paddingTop, paddingBottom, backgroundColor: colors.background, zIndex }]}>{children}</View>;
}
