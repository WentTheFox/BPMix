import type { ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { CrossfadeArt } from './CrossfadeArt';
import { LoadingBar } from './LoadingBar';
import { SeekBar } from './SeekBar';
import type { Colors } from './theme';
import { VolumeSlider } from './VolumeSlider';

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface NowPlayingBarProps {
  colors: Colors;
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
 * The now-playing block shared between mobile and web: title/up-next text,
 * CrossfadeArt, the seek bar (or loading bar) with its time labels, a caller-
 * supplied transport-controls slot, and the volume slider. Extracted for the
 * same reason as LibraryScreen - this exact shape (container style included)
 * had drifted into two separately-maintained copies.
 */
export function NowPlayingBar({
  colors,
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
}: NowPlayingBarProps) {
  return (
    <View style={styles.nowPlaying}>
      {/* No art thumbnail here - CrossfadeArt below already shows the
          current track's art at full size (its outgoing side, always
          rendered once duration is known, opaque whenever nothing's
          actually crossfading), so a second small copy next to the title
          would just be the same image twice. */}
      <Animated.View style={[styles.nowPlayingHeader, { opacity: nowPlayingOpacity }]}>
        <View style={styles.nowPlayingHeaderText}>
          <Text style={[styles.nowPlayingName, { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
      </Animated.View>
      {/* Text only, deliberately no art thumbnail here - CrossfadeArt below
          already shows the incoming track's actual art (blended with the
          outgoing one, always rendered as a preview once duration is known,
          not just mid-crossfade), so a second copy of the same art would be
          redundant. */}
      {upNextTitle && (
        <Animated.View style={[styles.upNext, { opacity: upNextOpacity }]}>
          <Text style={[styles.upNextText, { color: colors.subtleText }]} numberOfLines={1}>
            Up next: {upNextTitle}
          </Text>
        </Animated.View>
      )}
      {/* Always mounted (not gated on there being a transition plan, which
          goes null during every track's brief loading phase before duration
          is known) - CrossfadeArt owns persistent state across track changes
          for its swap/fade animation, and unmounting it mid-transition would
          cut it short. */}
      <CrossfadeArt
        currentTrackKey={currentTrackKey}
        currentArtUri={currentArtUri}
        currentGain={currentGain}
        currentProgress={currentProgress}
        nextTrackKey={nextTrackKey}
        nextArtUri={nextArtUri}
        nextGain={nextGain}
        nextProgress={nextProgress}
      />
      {isLoading ? (
        <LoadingBar />
      ) : (
        <SeekBar positionSeconds={positionSeconds} durationSeconds={durationSeconds} onSeekTo={onSeekTo} />
      )}
      <View style={styles.seekTimesRow}>
        <Text style={[styles.seekTimeText, { color: colors.subtleText }]}>{formatSeconds(positionSeconds)}</Text>
        <Text style={[styles.seekTimeText, { color: colors.subtleText }]}>{formatSeconds(durationSeconds)}</Text>
      </View>
      {controls}
      <VolumeSlider volume={volume} onChangeVolume={onChangeVolume} />
    </View>
  );
}

const styles = StyleSheet.create({
  nowPlaying: {
    marginTop: 16,
    width: '100%',
    maxWidth: 480,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
  },
  nowPlayingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nowPlayingHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  upNext: {
    marginTop: 8,
  },
  upNextText: {
    fontSize: 12,
  },
  nowPlayingName: {
    fontSize: 15,
    fontWeight: '600',
  },
  seekTimesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  seekTimeText: {
    fontSize: 12,
  },
});
