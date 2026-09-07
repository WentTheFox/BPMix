import { mdiVolumeHigh, mdiVolumeLow, mdiVolumeMedium, mdiVolumeOff } from '@mdi/js';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import type { Colors } from './theme';
import { VolumeSlider } from './VolumeSlider';

export interface VolumeButtonProps {
  colors: Colors;
  volume: number;
  onChangeVolume: (volume: number) => void;
}

/** Mirrors Segoe Fluent Icons' own Volume0-3 four-level split (see the segoe-fluent-icons-codepoints memory) so the icon and its Windows glyph agree on where each threshold falls. */
function volumeIconPath(volume: number): string {
  if (volume <= 0) return mdiVolumeOff;
  if (volume < 1 / 3) return mdiVolumeLow;
  if (volume < 2 / 3) return mdiVolumeMedium;
  return mdiVolumeHigh;
}

/**
 * Replaces the always-visible volume bar in NowPlayingScreen's footer with
 * a small icon button that pops the slider open on demand - the bar took up
 * permanent space for a control most sessions never touch after setting it
 * once. The icon itself doubles as a loudness indicator (mute/low/medium/
 * high), each mapped to a hand-verified Windows codepoint (see
 * Icon.windows.tsx) - see the segoe-fluent-icons-codepoints memory for
 * where those came from.
 *
 * The popover is a plain absolutely-positioned View, not React Native's
 * Modal - this codebase has no existing Modal usage to follow, and rolling
 * a custom overlay avoids finding out about any Modal quirks on
 * react-native-windows (whose platform support tends to lag) the hard way.
 */
export function VolumeButton({ colors, volume, onChangeVolume }: VolumeButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.container}>
      <Pressable style={styles.button} onPress={() => setOpen((o) => !o)}>
        <Icon path={volumeIconPath(volume)} size={20} color={colors.subtleText} />
      </Pressable>
      {open && (
        <>
          {/* Covers the whole screen (not just this row) so a tap anywhere outside the popover closes it. */}
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
          <View style={[styles.popover, { backgroundColor: colors.background, borderColor: colors.accent }]}>
            <VolumeSlider colors={colors} volume={volume} onChangeVolume={onChangeVolume} />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A big fixed-position rect rather than StyleSheet.absoluteFill relative
  // to `container` - container only wraps the button itself (auto height),
  // so an absoluteFill here would be button-sized, not full-screen.
  backdrop: {
    position: 'absolute',
    top: -2000,
    bottom: -2000,
    left: -2000,
    right: -2000,
  },
  // Re-centered over the button (the button is only 36px wide, narrower
  // than this) - left is negative by half the width difference so the
  // popover's midpoint lines up with the button's midpoint rather than its
  // left edge. Anchoring to the button's right edge instead (right: 0) was
  // tried first and rejected: for a button near the screen's right edge
  // (e.g. the last icon in a transport row), that pushed most of a wide
  // popover off-screen - confirmed on-device. Centering plus staying
  // narrow (this is a vertical slider, not a horizontal bar) keeps it
  // within the screen for any reasonable button position instead.
  popover: {
    position: 'absolute',
    bottom: '100%',
    left: (36 - 64) / 2,
    width: 64,
    marginBottom: 8,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
