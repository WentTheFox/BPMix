import type { LoopMode } from '@bpmix/core';
import { mdiFastForward10, mdiPause, mdiPlay, mdiRewind10, mdiSkipNext, mdiSkipPrevious } from '@mdi/js';
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
  /** Disables every button in the row (mid-scrub on both apps - see either App.tsx's own doc on why a second transport action mid-scrub risks the native-source-churn crash). */
  disabled?: boolean;
  /**
   * Web-only seek-by-10-seconds pair, rendered between Previous/Play and
   * Play/Next respectively - omit both (mobile's call site) to render
   * Android's plain 6-button row with nothing between them. Kept optional
   * rather than a separate mobile/web component so this stays the single
   * source of truth for the row's actual layout (order, spacing, sizing) -
   * see this file's own history: LoopShuffleButtons.tsx used to argue no
   * single component could cover both apps' differing button placements,
   * which is exactly the drift this component now exists to close.
   */
  onSeekBackward?: () => void;
  onSeekForward?: () => void;
}

/**
 * The Now Playing screen's full transport row - Loop, Previous, (web-only
 * seek back), Play/Pause, (web-only seek forward), Next, Shuffle, Volume -
 * shared so mobile and web can't independently drift in button order,
 * spacing, or sizing the way they did before this was extracted (mobile's
 * single-row layout is the source of truth; web used to split this into two
 * separate rows with its own seek-by-10s buttons wedged in a different
 * place entirely).
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
  disabled,
  onSeekBackward,
  onSeekForward,
}: PlayerControlsRowProps) {
  return (
    <View style={styles.row}>
      <LoopButton colors={colors} loopMode={loopMode} onPress={onCycleLoop} disabled={disabled} />
      <Pressable style={[styles.button, { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]} onPress={onPrevious} disabled={disabled}>
        <Icon path={mdiSkipPrevious} size={20} color="white" />
      </Pressable>
      {onSeekBackward && (
        <Pressable style={[styles.buttonWide, { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]} onPress={onSeekBackward} disabled={disabled}>
          <Icon path={mdiRewind10} size={22} color="white" />
        </Pressable>
      )}
      <Pressable
        style={[styles.button, styles.buttonPrimary, { backgroundColor: darken(colors.accent, 0.15) }, disabled && styles.buttonDisabled]}
        onPress={onTogglePlayPause}
        disabled={disabled}
      >
        <Icon path={isPlaying ? mdiPause : mdiPlay} size={30} color="white" />
      </Pressable>
      {onSeekForward && (
        <Pressable style={[styles.buttonWide, { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]} onPress={onSeekForward} disabled={disabled}>
          <Icon path={mdiFastForward10} size={22} color="white" />
        </Pressable>
      )}
      <Pressable style={[styles.button, { backgroundColor: colors.accent }, disabled && styles.buttonDisabled]} onPress={onNext} disabled={disabled}>
        <Icon path={mdiSkipNext} size={20} color="white" />
      </Pressable>
      <ShuffleButton colors={colors} shuffleEnabled={shuffleEnabled} onPress={onToggleShuffle} disabled={disabled} />
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
  buttonWide: {
    width: 60,
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
