import { trackDisplayName, METADATA_PARSER_VERSION, type LibraryStore, type TrackRecord } from '@bpmix/core';
import { mdiPause, mdiPlay } from '@mdi/js';
import { memo, useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { useCoverArt } from './useCoverArt';
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
  /** Text color for a non-current row - a current row always uses the accent color instead, regardless of this. */
  textColor: string;
  onPress: (track: TrackRecord) => void;
  libraryStore: LibraryStore;
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
export const TrackRow = memo(function TrackRow({ track, isCurrent, isPlaying, textColor, onPress, libraryStore }: TrackRowProps) {
  const metadata = useTrackMetadata(libraryStore, track.fileId);
  // Not just metadata !== null - useTrackMetadata can display a still-stale
  // (older parserVersion) result immediately while it keeps retrying, and
  // that stale snapshot may predate cover art existing at all.
  const coverArt = useCoverArt(libraryStore, track.fileId, metadata?.parserVersion === METADATA_PARSER_VERSION);

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

  return (
    <Pressable style={styles.trackRow} onPress={() => onPress(track)}>
      <View style={styles.trackRowContent}>
        <View style={styles.art}>
          <View style={[styles.art, styles.artPlaceholder]} />
          {coverArt && <Animated.Image source={{ uri: coverArt }} style={[styles.art, styles.artOverlay, { opacity: artOpacity }]} />}
          {isCurrent && (
            <View style={[styles.art, styles.artOverlay, styles.artCurrentTint]}>
              <Icon path={isPlaying ? mdiPause : mdiPlay} size={18} color="#fff" />
            </View>
          )}
        </View>
        <View style={styles.trackTextColumn}>
          <Text style={[styles.trackTitle, { color: isCurrent ? '#3b82f6' : textColor }]} numberOfLines={1}>
            {title}
          </Text>
          {artist && (
            <Text style={[styles.trackArtist, { color: textColor }]} numberOfLines={1}>
              {artist}
            </Text>
          )}
        </View>
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
    backgroundColor: 'rgba(59,130,246,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackTextColumn: {
    flexShrink: 1,
    minWidth: 0,
  },
  trackTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  trackArtist: {
    fontSize: 12,
    opacity: 0.7,
    marginTop: 1,
  },
});
