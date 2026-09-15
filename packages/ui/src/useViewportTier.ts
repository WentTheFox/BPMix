import { useWindowDimensions } from 'react-native';

export type ViewportTier = 'narrow' | 'medium' | 'wide';

/**
 * Playlist + docked Now Playing side by side (see MultiPaneLayout) needs
 * roughly two of the app's own ~480px column width plus a bit of breathing
 * room for the divider - narrower than that and a docked Now Playing pane
 * would be too cramped to read comfortably next to a playlist.
 */
const MEDIUM_MIN_WIDTH = 820;

/** Library + playlist + docked Now Playing, three ~480px-ish columns at once. */
const WIDE_MIN_WIDTH = 1180;

/**
 * The one place viewport width turns into a layout decision - see
 * MultiPaneLayout's doc for what each tier actually renders. Built on RN's
 * own useWindowDimensions (works identically on Android/Windows/web via
 * react-native-web) rather than anything platform-specific: neither
 * react-native-windows nor an Android tablet/foldable have a fixed window
 * width, so this genuinely needs to be reactive on every platform, not just
 * read once - see CLAUDE.md's "full platform parity" convention.
 */
export function useViewportTier(): ViewportTier {
  const { width } = useWindowDimensions();
  if (width >= WIDE_MIN_WIDTH) return 'wide';
  if (width >= MEDIUM_MIN_WIDTH) return 'medium';
  return 'narrow';
}
