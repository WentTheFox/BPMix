import { mdiPause, mdiPlay, mdiSkipNext, mdiSkipPrevious } from '@mdi/js';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import type { Colors } from './theme';
import { VolumeButton } from './VolumeButton';

export interface MiniPlayerBarProps {
  colors: Colors;
  /** Track title (or a bare fileId/filename fallback) - callers own useTrackMetadata, this just renders the result. */
  title: string;
  /** Artist(s), already joined - null hides the second line entirely rather than rendering it empty. */
  artist?: string | null;
  artUri: string | null;
  isPlaying: boolean;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  onChangeVolume: (volume: number) => void;
  /** Opens the full NowPlayingScreen - fired by tapping the art/title area, not the transport buttons. */
  onPress: () => void;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  /**
   * True when nothing is loaded (no playlist/track) - dims and disables
   * play-pause/next/previous, which are no-ops at the player level anyway
   * with an empty playlist (see PlaylistPlayer.play/next/previous). Volume
   * and the info-area tap (still opens NowPlayingScreen, where loop/shuffle
   * live) stay reachable regardless, per CLAUDE.md's UI/UX TODO on this.
   */
  disabled?: boolean;
}

/**
 * The fixed bottom bar every screen shows, always - art + title (tap to
 * open NowPlayingScreen) on the left, volume/play-pause/next/previous on
 * the right, with a thin progress line along the top edge. Rendered even
 * with nothing loaded (see `disabled`) so volume stays reachable and
 * NowPlayingScreen (where loop/shuffle live) stays a tap away regardless
 * of playlist state. Loop, shuffle, and seek stayed on NowPlayingScreen
 * per the TODO this replaces, but volume is shown here unconditionally
 * (ignoring settings.showVolumeButtonOnNowPlaying, which only hides the
 * copy on NowPlayingScreen's PlayerControlsRow) since it's the one control
 * users reach for without opening the full screen first.
 */
export function MiniPlayerBar({
  colors,
  title,
  artist,
  artUri,
  isPlaying,
  positionSeconds,
  durationSeconds,
  volume,
  onChangeVolume,
  onPress,
  onPlayPause,
  onNext,
  onPrevious,
  disabled = false,
}: MiniPlayerBarProps) {
  const progress = durationSeconds > 0 ? Math.min(1, Math.max(0, positionSeconds / durationSeconds)) : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: colors.accent }]} />
      </View>
      <View style={styles.row}>
        <Pressable style={styles.infoArea} onPress={onPress}>
          {artUri ? (
            <Image source={{ uri: artUri }} style={styles.art} />
          ) : (
            <View style={[styles.art, styles.artPlaceholder]} />
          )}
          <View style={styles.textColumn}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
              {title}
            </Text>
            {artist && (
              <Text style={[styles.artist, { color: colors.subtleText }]} numberOfLines={1}>
                {artist}
              </Text>
            )}
          </View>
        </Pressable>
        <View style={styles.controls}>
          <VolumeButton colors={colors} volume={volume} onChangeVolume={onChangeVolume} />
          <Pressable style={[styles.controlButton, disabled && styles.controlButtonDisabled]} onPress={onPrevious} disabled={disabled}>
            <Icon path={mdiSkipPrevious} size={22} color={colors.text} />
          </Pressable>
          <Pressable style={[styles.controlButton, disabled && styles.controlButtonDisabled]} onPress={onPlayPause} disabled={disabled}>
            <Icon path={isPlaying ? mdiPause : mdiPlay} size={26} color={colors.text} />
          </Pressable>
          <Pressable style={[styles.controlButton, disabled && styles.controlButtonDisabled]} onPress={onNext} disabled={disabled}>
            <Icon path={mdiSkipNext} size={22} color={colors.text} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.3)',
  },
  progressTrack: {
    height: 2,
    width: '100%',
    backgroundColor: 'rgba(128,128,128,0.25)',
  },
  progressFill: {
    height: 2,
  },
  // Capped and centered rather than stretching edge-to-edge - on a wide
  // viewport (see useViewportTier) an uncapped flex:1 infoArea/controls
  // pairing spread the art+title and transport buttons apart across the
  // whole window width, which is exactly the "now playing bar... spread out
  // across the entire width of the screen" CLAUDE.md's UI/UX TODO called
  // out. A narrow phone screen is already well under this cap, so it's a
  // no-op there.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    maxWidth: 900,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 12,
  },
  infoArea: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  art: {
    width: 40,
    height: 40,
    borderRadius: 4,
  },
  artPlaceholder: {
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  textColumn: {
    flexShrink: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  artist: {
    fontSize: 12,
    marginTop: 1,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 4,
  },
  controlButton: {
    padding: 6,
  },
  controlButtonDisabled: {
    opacity: 0.4,
  },
});
