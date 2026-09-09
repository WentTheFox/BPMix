import { Image, StyleSheet, Text, View } from 'react-native';

export interface AppTitleProps {
  color: string;
}

/**
 * The "BPMix" title/app-icon header - identical in both apps' library and
 * restoring screens (four call sites total before this was extracted).
 * Sized to match the plain-text back-link titles used by every other
 * screen's HeaderRow (the playlist/Now Playing screens) rather than
 * standing out as a much larger logo lockup.
 *
 * The icon itself needs a real bundled image (the app's actual vinyl-record
 * icon, not an mdi glyph) - Metro (mobile) resolves a local require() like
 * this natively, but Vite (web) has no such asset-registry shim configured,
 * so this default only covers mobile - see AppTitle.web.tsx for the web
 * variant pointing at the already-published PWA icon instead.
 */
export function AppTitle({ color }: AppTitleProps) {
  return (
    <View style={styles.row}>
      {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
      <Image source={require('./assets/app-icon.png')} style={styles.icon} />
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
  icon: {
    width: 22,
    height: 22,
    borderRadius: 5,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
  },
});
