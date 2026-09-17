import type { LoopMode } from '@bpmix/core';
import { mdiPause, mdiPlay, mdiSkipNext, mdiSkipPrevious } from '@mdi/js';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import { LoopButton, ShuffleButton } from './LoopShuffleButtons';
import type { Colors } from './theme';
import { darken } from './theme';
import { VolumeButton } from './VolumeButton';

export interface PlayerControlsRowProps {
  colors: Colors;
  loopMode: LoopMode;
  onCycleLoop: () => void;
  shuffleEnabled: boolean;
  onToggleShuffle: () => void;
  volume: number;
  onChangeVolume: (volume: number) => void;
  /** Defaults to true. False hides VolumeButton entirely - see AppSettings.showVolumeButtonOnNowPlaying's doc for why volume stays reachable regardless (the Settings screen's own slider is never hidden). */
  showVolumeButton?: boolean;
  isPlaying: boolean;
  onTogglePlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  /**
   * True when nothing is loaded (no playlist/track) - dims and disables
   * previous/play-pause/next, which are no-ops at the player level anyway
   * with an empty playlist. Loop, shuffle, and volume stay fully live
   * regardless, since they work (and are meant to be reachable) with no
   * track loaded - see CLAUDE.md's UI/UX TODO on this.
   */
  disabled?: boolean;
}

/**
 * The Now Playing screen's full transport row - Loop, Previous, Play/Pause,
 * Next, Shuffle, Volume - shared so mobile and web can't independently drift
 * in button order, spacing, or sizing the way they did before this was
 * extracted (web used to split this into two separate rows with its own
 * seek-by-10s buttons wedged in a different place entirely - removed
 * outright rather than kept as a web-only deviation, per this project's
 * full-platform-parity preference; ±10s seeking is still reachable via the
 * seek bar itself on both platforms).
 */
export function PlayerControlsRow({
  colors,
  loopMode,
  onCycleLoop,
  shuffleEnabled,
  onToggleShuffle,
  volume,
  onChangeVolume,
  showVolumeButton = true,
  isPlaying,
  onTogglePlayPause,
  onPrevious,
  onNext,
  disabled = false,
}: PlayerControlsRowProps) {
  return (
    <View style={styles.row}>
      <LoopButton colors={colors} loopMode={loopMode} onPress={onCycleLoop} />
      <Pressable
        style={[styles.button, { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]}
        onPress={onPrevious}
        disabled={disabled}
      >
        <Icon path={mdiSkipPrevious} size={20} color="white" />
      </Pressable>
      <Pressable
        style={[styles.button, styles.buttonPrimary, { backgroundColor: darken(colors.accent, 0.15) }, disabled && styles.buttonDisabled]}
        onPress={onTogglePlayPause}
        disabled={disabled}
      >
        <Icon path={isPlaying ? mdiPause : mdiPlay} size={30} color="white" />
      </Pressable>
      <Pressable
        style={[styles.button, { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]}
        onPress={onNext}
        disabled={disabled}
      >
        <Icon path={mdiSkipNext} size={20} color="white" />
      </Pressable>
      <ShuffleButton colors={colors} shuffleEnabled={shuffleEnabled} onPress={onToggleShuffle} />
      {showVolumeButton && <VolumeButton colors={colors} volume={volume} onChangeVolume={onChangeVolume} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginTop: 12,
    marginBottom: 4,
  },
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: {
    width: 72,
    height: 72,
    borderRadius: 36,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
});
