import { StyleSheet, View } from 'react-native';

export interface AppIconMarkProps {
  /** Tracks the settings screen's accent color choice - see AppTitle's doc for why this replaced the static app-icon.png/icon-192.png image it used to render. */
  accentColor: string;
  size?: number;
}

/** Matches the real app icon's fixed dark navy record body - a brand color, not a themed one, so it stays constant regardless of light/dark mode or the chosen accent. */
const RECORD_COLOR = '#12141c';

/**
 * A simplified recreation of the app's vinyl-record icon: a circular record
 * body (RECORD_COLOR), an accent-colored label in the middle, and a small
 * spindle-hole dot - composited on a circle, like the real record, rather
 * than the square backing plate the real app icon/PWA icon files used to
 * sit on (also since fixed, made transparent outside that circle - see
 * their own doc for why a flat square background read as a plain dark box
 * on the home screen instead of a clean record silhouette).
 *
 * Built from plain Views rather than the bundled app-icon.png/icon-192.png
 * raster image those two files used to render - a flat multi-tone bitmap
 * can't be recolored with a tintColor prop (that would flatten the whole
 * image to one color) the way this app's other icons already recolor via a
 * plain `color` prop. Plain Views rather than react-native-svg so this
 * works identically on every platform, Windows included (no
 * react-native-svg build there - see Icon.windows.tsx's header comment for
 * why).
 */
export function AppIconMark({ accentColor, size = 22 }: AppIconMarkProps) {
  const discSize = size * 0.64;
  const holeSize = size * 0.18;
  return (
    <View style={[styles.record, { width: size, height: size, borderRadius: size / 2 }]}>
      <View style={[styles.label, { width: discSize, height: discSize, borderRadius: discSize / 2, backgroundColor: accentColor }]}>
        <View style={[styles.hole, { width: holeSize, height: holeSize, borderRadius: holeSize / 2 }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  record: {
    backgroundColor: RECORD_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  hole: {
    backgroundColor: RECORD_COLOR,
  },
});
