import type { LoopMode } from '@bpmix/core';
import { mdiRepeat, mdiRepeatOnce, mdiShuffle } from '@mdi/js';
import { Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';

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
 * Two separate components, not one combined widget - mobile flanks
 * prev/play/next with these (loop on the left, shuffle on the right),
 * while web groups them together in their own row, so a single component
 * covering both button placements can't fit both layouts.
 */
export function LoopButton({ loopMode, onPress }: { loopMode: LoopMode; onPress: () => void }) {
  return (
    <Pressable style={[styles.button, loopMode !== 'off' && styles.buttonActive]} onPress={onPress}>
      <Icon path={LOOP_MODE_ICON[loopMode]} size={18} color="white" />
    </Pressable>
  );
}

export function ShuffleButton({ shuffleEnabled, onPress }: { shuffleEnabled: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.button, shuffleEnabled && styles.buttonActive]} onPress={onPress}>
      <Icon path={mdiShuffle} size={18} color="white" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Smaller and dimmer than the primary transport buttons they sit
  // alongside - secondary controls, not primary ones - lighting up
  // (buttonActive) when their mode is non-default, since the icon glyph
  // alone can't carry on/off state for shuffle (same icon either way).
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#475569',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonActive: {
    backgroundColor: '#3b82f6',
  },
});
