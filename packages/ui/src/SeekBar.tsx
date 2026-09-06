import { useEffect, useRef, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { Animated, Easing, PanResponder, StyleSheet, View } from 'react-native';

export interface SeekBarProps {
  positionSeconds: number;
  durationSeconds: number;
  onSeekTo: (positionSeconds: number) => void;
  /**
   * Fired on every touch-move tick while dragging (and once more with null
   * on release/terminate) - lets a caller mirror the live drag position
   * elsewhere (e.g. the crossfade disc's rotation) without waiting for the
   * debounced real seek. Never gated by SEEK_COMMIT_DEBOUNCE_MS - purely
   * visual, so there's no native-source-churn concern in firing it on
   * every tick the way there is for onSeekTo.
   */
  onPreview?: (positionSeconds: number | null) => void;
  /**
   * Set while TrackPlayer.rewindTo()/fastForwardTo()'s sped-up scrub effect
   * is in flight (see PlaylistPlayerState.track.scrubbing) - the blue fill
   * jumps straight to toSeconds immediately (rather than tracking
   * positionSeconds, which is genuinely counting up/down for the effect's
   * duration and would otherwise read as "jumped to the target, then
   * slowly rolled there instead"), and a white highlight spanning
   * [min, max](fromSeconds, toSeconds) shrinks away over durationSeconds
   * instead - conveying "this stretch is being scrubbed through" without
   * the fill itself visibly moving backward (or, for a fast-forward,
   * visibly crawling forward before snapping ahead).
   */
  scrubbing?: { fromSeconds: number; toSeconds: number; durationSeconds: number } | null;
}

/** How long a drag has to sit idle before its position is actually committed (see onSeekTo) - only matters mid-drag, since a release always commits immediately regardless. Keeps a held drag from calling onSeekTo on every touch-move tick, which is the same rapid-fire native-source-churn pattern real seeking-while-dragging used to avoid entirely by not supporting drag at all. Generous on purpose: a fast/flicked drag (e.g. spinning the disc preview quickly across a big range) should feel free to keep moving without triggering a real seek - and thus a real native-source teardown/recreate - until it actually settles. */
const SEEK_COMMIT_DEBOUNCE_MS = 500;

/**
 * Tap or drag to seek. The bar's fill tracks the finger/pointer immediately
 * (previewFraction) for smooth visual feedback, but the real onSeekTo() -
 * which tears down and recreates the native audio source - only fires once
 * input actually stops: on release, or after SEEK_COMMIT_DEBOUNCE_MS of
 * holding still mid-drag. This is what lets dragging feel responsive
 * without reintroducing the rapid-fire native-source-churn pattern that
 * crashes react-native-audio-api on Android (a single tap already only
 * ever fired one seek() call; a drag now behaves the same way once your
 * finger actually settles, instead of firing continuously).
 */
export function SeekBar({ positionSeconds, durationSeconds, onSeekTo, onPreview, scrubbing }: SeekBarProps) {
  // event.nativeEvent.locationX is unreliable on react-native-web (comes
  // back undefined there, unlike native RN) - measure() + pageX works on
  // both, so that's used instead of locationX everywhere.
  // Typed loosely: RN's own ref type here (ReactNativeElement) isn't a
  // public export, and this is a narrow, self-contained use of .measure().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackRef = useRef<any>(null);
  const widthRef = useRef(0);
  const pageXRef = useRef(0);
  const durationRef = useRef(durationSeconds);
  const onSeekToRef = useRef(onSeekTo);
  const onPreviewRef = useRef(onPreview);
  useEffect(() => {
    onPreviewRef.current = onPreview;
  }, [onPreview]);
  useEffect(() => {
    durationRef.current = durationSeconds;
  }, [durationSeconds]);
  useEffect(() => {
    onSeekToRef.current = onSeekTo;
  }, [onSeekTo]);

  const [previewFraction, setPreviewFraction] = useState<number | null>(null);
  const commitTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Width comes from onLayout (synchronous, always current by the time
  // anyone can actually touch the element) - NOT from .measure(), which is
  // async and was landing a stale/zero value for a gesture that started
  // right as a re-render swapped in a fresh element (e.g. right after a
  // track change), throwing the whole fraction off. pageX is still only
  // obtainable via .measure() (there's no synchronous "where is this
  // element on the page" event), but it's only needed for the web
  // locationX-fallback path below, not for the width denominator.
  const handleLayout = (event: LayoutChangeEvent) => {
    widthRef.current = event.nativeEvent.layout.width;
    measurePageX();
  };

  const measurePageX = () => {
    trackRef.current?.measure((_x: number, _y: number, _width: number, _height: number, pageX: number) => {
      pageXRef.current = pageX;
    });
  };

  const fractionFromEvent = (event: GestureResponderEvent): number | null => {
    if (widthRef.current <= 0 || durationRef.current <= 0) return null;
    // Prefer locationX (element-relative, no measure() dependency) when
    // it's actually a usable number - true on native RN. Falls back to
    // pageX minus the measured element offset, since locationX comes back
    // undefined on react-native-web.
    const relativeX = Number.isFinite(event.nativeEvent.locationX)
      ? event.nativeEvent.locationX
      : event.nativeEvent.pageX - pageXRef.current;
    if (!Number.isFinite(relativeX)) return null;
    return Math.max(0, Math.min(1, relativeX / widthRef.current));
  };

  const clearCommitTimeout = () => {
    if (commitTimeoutRef.current) {
      clearTimeout(commitTimeoutRef.current);
      commitTimeoutRef.current = undefined;
    }
  };

  const commit = (fraction: number) => {
    clearCommitTimeout();
    onSeekToRef.current(fraction * durationRef.current);
  };

  const scheduleCommit = (fraction: number) => {
    clearCommitTimeout();
    commitTimeoutRef.current = setTimeout(() => commit(fraction), SEEK_COMMIT_DEBOUNCE_MS);
  };

  useEffect(() => clearCommitTimeout, []);

  // Created once (not per-render) - the refs above give its closures access
  // to whatever's current without needing to be recreated when duration/
  // onSeekTo change identity.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        measurePageX();
        const fraction = fractionFromEvent(event);
        if (fraction == null) return;
        setPreviewFraction(fraction);
        onPreviewRef.current?.(fraction * durationRef.current);
        scheduleCommit(fraction);
      },
      onPanResponderMove: (event) => {
        const fraction = fractionFromEvent(event);
        if (fraction == null) return;
        setPreviewFraction(fraction);
        onPreviewRef.current?.(fraction * durationRef.current);
        scheduleCommit(fraction);
      },
      onPanResponderRelease: (event) => {
        const fraction = fractionFromEvent(event);
        if (fraction != null) commit(fraction);
        setPreviewFraction(null);
        onPreviewRef.current?.(null);
      },
      onPanResponderTerminate: () => {
        clearCommitTimeout();
        setPreviewFraction(null);
        onPreviewRef.current?.(null);
      },
    }),
  ).current;

  // While scrubbing, the fill jumps straight to the target (not
  // positionSeconds, which is genuinely counting up/down for the effect's
  // duration) - see scrubbing's own doc for why.
  const realFraction =
    scrubbing && durationSeconds > 0
      ? Math.max(0, Math.min(1, scrubbing.toSeconds / durationSeconds))
      : durationSeconds > 0
        ? Math.max(0, Math.min(1, positionSeconds / durationSeconds))
        : 0;
  const fillFraction = previewFraction ?? realFraction;

  const scrubShrink = useRef(new Animated.Value(0)).current;
  // Keyed on the scrub's own identity (its start/end/duration) rather than
  // just its presence, so a second scrub landing before the first's shrink
  // animation finished restarts cleanly from full width instead of
  // wherever the interrupted one left off.
  const scrubKey = scrubbing ? `${scrubbing.fromSeconds}-${scrubbing.toSeconds}-${scrubbing.durationSeconds}` : null;
  useEffect(() => {
    if (!scrubbing) return;
    scrubShrink.setValue(1);
    Animated.timing(scrubShrink, {
      toValue: 0,
      duration: scrubbing.durationSeconds * 1000,
      easing: Easing.linear,
      useNativeDriver: false, // animating `width`, which the native driver can't do
    }).start();
    // scrubKey (derived from scrubbing) is the real dependency - see its own doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubKey]);

  // min/max rather than assuming an order - fromSeconds > toSeconds for a
  // rewind, fromSeconds < toSeconds for a fast-forward.
  const scrubLeftFraction =
    scrubbing && durationSeconds > 0 ? Math.max(0, Math.min(1, Math.min(scrubbing.fromSeconds, scrubbing.toSeconds) / durationSeconds)) : 0;
  const scrubSpanFraction =
    scrubbing && durationSeconds > 0 ? Math.max(0, Math.min(1, Math.abs(scrubbing.fromSeconds - scrubbing.toSeconds) / durationSeconds)) : 0;

  return (
    <View
      ref={trackRef}
      style={styles.seekBarTrack}
      onLayout={handleLayout}
      hitSlop={{ top: 14, bottom: 14, left: 4, right: 4 }}
      {...panResponder.panHandlers}
    >
      <View style={[styles.seekBarFill, { width: `${fillFraction * 100}%` }]} />
      {scrubbing && (
        <Animated.View
          style={[
            styles.scrubHighlight,
            {
              left: `${scrubLeftFraction * 100}%`,
              width: scrubShrink.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${scrubSpanFraction * 100}%`] }),
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  seekBarTrack: {
    height: 10,
    marginTop: 12,
    borderRadius: 5,
    backgroundColor: 'rgba(59, 130, 246, 0.25)',
    overflow: 'hidden',
  },
  seekBarFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
  },
  // Sits on top of seekBarFill (later sibling), covering the stretch
  // currently being scrubbed through - see scrubbing's own doc.
  scrubHighlight: {
    position: 'absolute',
    top: 0,
    height: '100%',
    backgroundColor: '#fff',
  },
});
