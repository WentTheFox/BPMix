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
  isPlaying: boolean;
  onTogglePlayPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
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
  isPlaying,
  onTogglePlayPause,
  onPrevious,
  onNext,
}: PlayerControlsRowProps) {
  return (
    <View style={styles.row}>
      <LoopButton colors={colors} loopMode={loopMode} onPress={onCycleLoop} />
      <Pressable style={[styles.button, { backgroundColor: colors.accent }]} onPress={onPrevious}>
        <Icon path={mdiSkipPrevious} size={20} color="white" />
      </Pressable>
      <Pressable
        style={[styles.button, styles.buttonPrimary, { backgroundColor: darken(colors.accent, 0.15) }]}
        onPress={onTogglePlayPause}
      >
        <Icon path={isPlaying ? mdiPause : mdiPlay} size={30} color="white" />
      </Pressable>
      <Pressable style={[styles.button, { backgroundColor: colors.accent }]} onPress={onNext}>
        <Icon path={mdiSkipNext} size={20} color="white" />
      </Pressable>
      <ShuffleButton colors={colors} shuffleEnabled={shuffleEnabled} onPress={onToggleShuffle} />
      <VolumeButton colors={colors} volume={volume} onChangeVolume={onChangeVolume} />
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
});
