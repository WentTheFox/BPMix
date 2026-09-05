import { mdiPause, mdiPlay, mdiSkipNext, mdiSkipPrevious } from '@mdi/js';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import type { Colors } from './theme';

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
  /** Opens the full NowPlayingScreen - fired by tapping the art/title area, not the transport buttons. */
  onPress: () => void;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

/**
 * The fixed bottom bar every screen shows once a track is loaded - art +
 * title (tap to open NowPlayingScreen) on the left, play/pause/next/previous
 * on the right, with a thin progress line along the top edge. Deliberately
 * just these four transport actions per the TODO this replaces ("play-pause-
 * next-previous controls on the right") - loop, shuffle, seek, and volume
 * all moved to NowPlayingScreen instead of crowding this bar.
 */
export function MiniPlayerBar({
  colors,
  title,
  artist,
  artUri,
  isPlaying,
  positionSeconds,
  durationSeconds,
  onPress,
  onPlayPause,
  onNext,
  onPrevious,
}: MiniPlayerBarProps) {
  const progress = durationSeconds > 0 ? Math.min(1, Math.max(0, positionSeconds / durationSeconds)) : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
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
          <Pressable style={styles.controlButton} onPress={onPrevious}>
            <Icon path={mdiSkipPrevious} size={22} color={colors.text} />
          </Pressable>
          <Pressable style={styles.controlButton} onPress={onPlayPause}>
            <Icon path={isPlaying ? mdiPause : mdiPlay} size={26} color={colors.text} />
          </Pressable>
          <Pressable style={styles.controlButton} onPress={onNext}>
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
    backgroundColor: '#3b82f6',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
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
});
