import { formatDuration, isMetadataCurrent, trackDisplayName, type LibraryStore, type TrackRecord } from '@bpmix/core';
import { mdiAlertCircleOutline, mdiPause, mdiPlay, mdiPlaylistPlus, mdiSubtitles } from '@mdi/js';
import { memo, useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { Skeleton } from './Skeleton';
import type { Colors } from './theme';
import { withAlpha } from './theme';
import { useCoverArt } from './useCoverArt';
import { useHasLyrics } from './useHasLyrics';
import { useTrackMetadata } from './useTrackMetadata';

const ART_FADE_IN_MS = 250;
const ART_SIZE = 40;
const ROW_VERTICAL_PADDING = 8;

/**
 * Every row is exactly this tall (art is the tallest element, padding is
 * fixed) regardless of whether its metadata/art has loaded yet - exported
 * so the FlatList rendering these can pass a `getItemLayout` computed from
 * it. Since the playlist's length is known upfront, that lets FlatList
 * compute every row's scroll position by arithmetic instead of measuring
 * as it goes, which is what actually causes a long list to jump/jank when
 * scrolling near the end - a skeleton-style instant layout only helps if
 * the list's own virtualization can also skip measurement.
 */
export const TRACK_ROW_HEIGHT = ART_SIZE + ROW_VERTICAL_PADDING * 2;

export interface TrackRowProps {
  track: TrackRecord;
  isCurrent: boolean;
  isPlaying: boolean;
  /** True while the current track is decoding (PlaylistPlayer status 'loading') - shows a spinner over the art instead of a static play glyph, so tapping a track doesn't look like nothing happened until the decode finishes. Only meaningful when isCurrent. */
  isLoading?: boolean;
  /** Text color for a non-current row - a current row always uses colors.accent instead, regardless of this. */
  textColor: string;
  colors: Colors;
  onPress: (track: TrackRecord) => void;
  libraryStore: LibraryStore;
  /** True once this track's most recent playback attempt failed to decode (missing/unreadable file - see PlaylistPlayer's onError fileId doc) - fades the row and shows a warning icon on the right, rather than looking identical to a perfectly playable track until tapped. */
  isMissing?: boolean;
  /** Shows a per-row "add to playlist" button when given (see AddToPlaylistDialog) - only passed by the Unplaylisted automatic view today, since a track already sitting in a real playlist has nowhere new to be added to from here. Omitted (not just falsy) elsewhere, so an ordinary playlist screen's rows look exactly as they did before this existed. */
  onAddToPlaylist?: (track: TrackRecord) => void;
}

/**
 * One row in a playlist's track list: cover art thumbnail (cross-dissolves
 * in once scanned, if the file has any - see the artOpacity animation),
 * title on its own line with artist(s) beneath (or the filename until
 * metadata is scanned/if it has none), and - for the current track only -
 * a blue tint over the art itself with a centered play/pause glyph
 * reflecting actual playback state, rather than a separate icon next to
 * the text. Shared between mobile and web (identical on both, so it lives
 * here rather than being duplicated per-app).
 */
export const TrackRow = memo(function TrackRow({ track, isCurrent, isPlaying, isLoading, textColor, colors, onPress, libraryStore, isMissing, onAddToPlaylist }: TrackRowProps) {
  const metadata = useTrackMetadata(libraryStore, track.fileId);
  // Not just metadata !== null - useTrackMetadata can display a still-stale
  // (older parserVersion) result immediately while it keeps retrying, and
  // that stale snapshot may predate cover art existing at all.
  const metadataCurrent = isMetadataCurrent(metadata);
  const coverArt = useCoverArt(libraryStore, track.fileId, metadataCurrent);
  // True only while genuinely still waiting on the scan to reach this
  // track - once metadata is current we know for certain whether there's
  // art or not, so a still-shimmering placeholder past that point would be
  // lying about there being more to load.
  const artLoading = !metadataCurrent;
  const hasLyrics = useHasLyrics(libraryStore, track.fileId);

  // Cross-dissolves from the placeholder to the art once it loads, rather
  // than popping in - the placeholder stays underneath throughout (never
  // unmounted), so this is just the Image layer fading in on top of it.
  const artOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (coverArt) {
      Animated.timing(artOpacity, { toValue: 1, duration: ART_FADE_IN_MS, useNativeDriver: true }).start();
    } else {
      artOpacity.setValue(0);
    }
  }, [coverArt, artOpacity]);

  const title = metadata?.title || trackDisplayName(track);
  const artist = metadata?.artists.join(', ') || null;
  const album = metadata?.album || null;
  const artistLine = artist && album ? `${artist} — ${album}` : artist || album;
  const duration = metadata?.durationSeconds != null ? formatDuration(metadata.durationSeconds) : null;

  return (
    <Pressable style={styles.trackRow} onPress={() => onPress(track)}>
      <View style={[styles.trackRowContent, isMissing && styles.trackRowContentMissing]}>
        <View style={styles.art}>
          {artLoading ? <Skeleton style={styles.art} /> : <View style={[styles.art, styles.artPlaceholder]} />}
          {coverArt && <Animated.Image source={{ uri: coverArt }} style={[styles.art, styles.artOverlay, { opacity: artOpacity }]} />}
          {isCurrent && (
            <View style={[styles.art, styles.artOverlay, styles.artCurrentTint, { backgroundColor: withAlpha(colors.accent, 0.55) }]}>
              {isLoading ? <ActivityIndicator size="small" color="#fff" /> : <Icon path={isPlaying ? mdiPause : mdiPlay} size={18} color="#fff" />}
            </View>
          )}
        </View>
        <View style={styles.trackTextColumn}>
          <View style={styles.titleRow}>
            <Text style={[styles.trackTitle, { color: isCurrent ? colors.accent : textColor }]} numberOfLines={1}>
              {title}
            </Text>
            {hasLyrics && <Icon path={mdiSubtitles} size={13} color={isCurrent ? colors.accent : textColor} />}
          </View>
          {artistLine ? (
            <Text style={[styles.trackArtist, { color: textColor }]} numberOfLines={1}>
              {artistLine}
            </Text>
          ) : (
            artLoading && <Skeleton style={styles.artistSkeleton} />
          )}
        </View>
        {duration && (
          <Text style={[styles.trackDuration, { color: textColor }]} numberOfLines={1}>
            {duration}
          </Text>
        )}
        {isMissing && (
          <View>
            <Icon path={mdiAlertCircleOutline} size={18} color="#dc2626" />
          </View>
        )}
        {onAddToPlaylist && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              onAddToPlaylist(track);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Icon path={mdiPlaylistPlus} size={18} color={colors.accent} />
          </Pressable>
        )}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  trackRow: {
    paddingVertical: ROW_VERTICAL_PADDING,
    paddingHorizontal: 16,
  },
  trackRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  trackRowContentMissing: {
    opacity: 0.45,
  },
  trackDuration: {
    fontSize: 12,
    opacity: 0.6,
    flexShrink: 0,
  },
  art: {
    width: ART_SIZE,
    height: ART_SIZE,
    borderRadius: 4,
  },
  artOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  artPlaceholder: {
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  artCurrentTint: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Takes all the row's leftover width, so the trailing items (duration,
  // missing icon, add button) always sit flush right, in that order. They
  // used to each carry marginLeft: 'auto', which splits the free space
  // between them - with more than one present (e.g. duration + add button
  // in the Unplaylisted view) the duration drifted to wherever that split
  // landed, varying with the title/artist length.
  trackTextColumn: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  trackTitle: {
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  trackArtist: {
    fontSize: 12,
    opacity: 0.7,
    marginTop: 1,
  },
  artistSkeleton: {
    width: '40%',
    height: 10,
    marginTop: 4,
  },
});
