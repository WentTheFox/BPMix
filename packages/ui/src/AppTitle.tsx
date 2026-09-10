import { StyleSheet, Text, View } from 'react-native';
import { AppIconMark } from './AppIconMark';

export interface AppTitleProps {
  color: string;
  /** Settings' accent color choice - AppIconMark recolors its disc to match. */
  accentColor: string;
}

/**
 * The "BPMix" title/app-icon header - identical in both apps' library and
 * restoring screens (four call sites total before this was extracted).
 * Sized to match the plain-text back-link titles used by every other
 * screen's HeaderRow (the playlist/Now Playing screens) rather than
 * standing out as a much larger logo lockup.
 *
 * The icon itself is AppIconMark, not a bundled image - see its own doc for
 * why. AppTitle.web.tsx used to be a separate file only because Vite has no
 * RN-style asset-registry shim for a local require('./app-icon.png') the
 * way Metro does - AppIconMark needs no such require, so this default now
 * covers both platforms and AppTitle.web.tsx was removed as a duplicate.
 */
export function AppTitle({ color, accentColor }: AppTitleProps) {
  return (
    <View style={styles.row}>
      <AppIconMark accentColor={accentColor} size={22} />
      <Text style={[styles.title, { color }]}>BPMix</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
  },
});
