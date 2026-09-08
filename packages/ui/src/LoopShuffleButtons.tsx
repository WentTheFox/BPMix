import type { LoopMode } from '@bpmix/core';
import { mdiRepeat, mdiRepeatOnce, mdiShuffle } from '@mdi/js';
import { Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';
import type { Colors } from './theme';

// 'off' reuses the repeat-all glyph dimmed, rather than a distinct "repeat
// off" icon - Segoe Fluent Icons (the Windows Icon renderer's font) has no
// such glyph, so state is conveyed by icon shape + color together: off =
// dim mdiRepeat, all = lit mdiRepeat, one = lit mdiRepeatOnce.
const LOOP_MODE_ICON: Record<LoopMode, string> = { off: mdiRepeat, all: mdiRepeat, one: mdiRepeatOnce };

/**
 * Icon-only loop/shuffle toggles, shared so a future tweak to one app's
 * transport row can't quietly leave the other behind the way it did before
 * this was extracted (mobile went icon-only in 37ba0af; web kept the old
 * text-label buttons and a separate crossfade stepper for another day
 * before anyone noticed).
 *
 * Two separate components, not one combined widget, so PlayerControlsRow
 * (the shared full-row layout both apps now use) can place them at either
 * end of the row rather than needing them pre-glued together.
 */
export function LoopButton({
  colors,
  loopMode,
  onPress,
  disabled,
}: {
  colors: Colors;
  loopMode: LoopMode;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.button, loopMode !== 'off' && { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Icon path={LOOP_MODE_ICON[loopMode]} size={18} color="white" />
    </Pressable>
  );
}

export function ShuffleButton({
  colors,
  shuffleEnabled,
  onPress,
  disabled,
}: {
  colors: Colors;
  shuffleEnabled: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.button, shuffleEnabled && { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Icon path={mdiShuffle} size={18} color="white" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Smaller and dimmer than the primary transport buttons they sit
  // alongside - secondary controls, not primary ones - lighting up
  // (accent background) when their mode is non-default, since the icon
  // glyph alone can't carry on/off state for shuffle (same icon either way).
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#475569',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
});
