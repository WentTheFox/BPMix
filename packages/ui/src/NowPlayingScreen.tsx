import { mdiArrowLeft } from '@mdi/js';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { CrossfadeArt } from './CrossfadeArt';
import { IconLabel } from './IconLabel';
import { LoadingBar } from './LoadingBar';
import { SeekBar } from './SeekBar';
import type { Colors } from './theme';
import { VolumeSlider } from './VolumeSlider';

const ART_SIZE = 130;

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface NowPlayingScreenProps {
  colors: Colors;
  onClose: () => void;
  /** Already-formatted title text (or a bare fileId fallback) - callers own formatTrackTitle/useTrackMetadata, this just renders the result. */
  title: string;
  upNextTitle?: string | null;
  /** Drives the title/up-next block's fade-in on a settled track change - see each app's useFadeInOnChange call. */
  nowPlayingOpacity: Animated.Value;
  upNextOpacity: Animated.Value;
  currentTrackKey: string | null;
  currentArtUri: string | null;
  currentGain: number;
  currentProgress: number;
  nextTrackKey: string | null;
  nextArtUri: string | null;
  nextGain: number;
  nextProgress: number;
  isLoading: boolean;
  positionSeconds: number;
  durationSeconds: number;
  onSeekTo: (positionSeconds: number) => void;
  /** The primary transport row(s) - genuinely different between mobile (icon buttons flanked by loop/shuffle) and web (adds ±10s seek buttons, loop/shuffle on their own row), so left as a slot rather than forced into one shape. */
  controls: ReactNode;
  volume: number;
  onChangeVolume: (value: number) => void;
}

/**
 * The full-screen "now playing" view, opened by tapping MiniPlayerBar's
 * art/title area - everything that used to live in the always-visible
 * inline NowPlayingBar (CrossfadeArt, seek bar, transport controls, volume)
 * now lives here instead, reachable on demand rather than permanently
 * taking up space on the library/playlist screens. See CLAUDE.md's UI/UX
 * TODO this replaces.
 */
export function NowPlayingScreen({
  colors,
  onClose,
  title,
  upNextTitle,
  nowPlayingOpacity,
  upNextOpacity,
  currentTrackKey,
  currentArtUri,
  currentGain,
  currentProgress,
  nextTrackKey,
  nextArtUri,
  nextGain,
  nextProgress,
  isLoading,
  positionSeconds,
  durationSeconds,
  onSeekTo,
  controls,
  volume,
  onChangeVolume,
}: NowPlayingScreenProps) {
  // Live position while dragging the seek bar, mirrored here so the disc's
  // rotation and the position text can both track the drag in real time -
  // the real seek (onSeekTo) stays debounced (see SeekBar's own doc), this
  // is purely visual and updates on every touch-move tick.
  const [previewPositionSeconds, setPreviewPositionSeconds] = useState<number | null>(null);
  const displayPositionSeconds = previewPositionSeconds ?? positionSeconds;
  const displayCurrentProgress = previewPositionSeconds != null && durationSeconds > 0 ? previewPositionSeconds / durationSeconds : currentProgress;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Pressable style={styles.backRow} onPress={onClose}>
        <IconLabel path={mdiArrowLeft} text="Now Playing" color={colors.text} iconSize={18} textStyle={styles.backLink} />
      </Pressable>
      <View style={styles.content}>
        <View>
          <Animated.View style={{ opacity: nowPlayingOpacity }}>
            <Text style={[styles.nowPlayingName, { color: colors.text }]} numberOfLines={2}>
              {title}
            </Text>
          </Animated.View>
          {upNextTitle && (
            <Animated.View style={[styles.upNext, { opacity: upNextOpacity }]}>
              <Text style={[styles.upNextText, { color: colors.subtleText }]} numberOfLines={1}>
                Up next: {upNextTitle}
              </Text>
            </Animated.View>
          )}
          <View style={styles.artRow}>
            <CrossfadeArt
              currentTrackKey={currentTrackKey}
              currentArtUri={currentArtUri}
              currentGain={currentGain}
              currentProgress={displayCurrentProgress}
              nextTrackKey={nextTrackKey}
              nextArtUri={nextArtUri}
              nextGain={nextGain}
              nextProgress={nextProgress}
              size={ART_SIZE}
            />
          </View>
          {isLoading ? (
            <LoadingBar />
          ) : (
            <SeekBar
              positionSeconds={positionSeconds}
              durationSeconds={durationSeconds}
              onSeekTo={onSeekTo}
              onPreview={setPreviewPositionSeconds}
            />
          )}
          <View style={styles.seekTimesRow}>
            <Text style={[styles.seekTimeText, { color: colors.subtleText }]}>{formatSeconds(displayPositionSeconds)}</Text>
            <Text style={[styles.seekTimeText, { color: colors.subtleText }]}>{formatSeconds(durationSeconds)}</Text>
          </View>
        </View>
        <View style={styles.footer}>
          {controls}
          <VolumeSlider volume={volume} onChangeVolume={onChangeVolume} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  backRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backLink: {
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  artRow: {
    alignItems: 'center',
    marginVertical: 24,
  },
  upNext: {
    marginTop: 8,
  },
  upNextText: {
    fontSize: 13,
  },
  nowPlayingName: {
    fontSize: 22,
    fontWeight: '700',
  },
  seekTimesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  seekTimeText: {
    fontSize: 12,
  },
  // Pushed to the bottom of `content` (flex:1, space-between) rather than
  // flowing right after the seek bar, so the transport controls land at a
  // consistent, reachable spot regardless of how much space the art/title
  // block above ends up taking.
  footer: {
    paddingBottom: 24,
  },
});
