import { useEffect, useRef, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';
import { MAX_CROSSFADE_SECONDS, MIN_CROSSFADE_SECONDS } from './types';

export interface CrossfadeSliderProps {
  colors: Colors;
  valueSeconds: number;
  onChangeSeconds: (seconds: number) => void;
}

const KNOB_SIZE = 20;
const RANGE = MAX_CROSSFADE_SECONDS - MIN_CROSSFADE_SECONDS;

/**
 * Tap or drag to pick a crossfade duration, snapped to whole seconds across
 * [MIN_CROSSFADE_SECONDS, MAX_CROSSFADE_SECONDS] - same tap-or-drag
 * PanResponder approach as SeekBar (locationX where available, falling back
 * to pageX minus the track's measured offset for react-native-web, where
 * locationX comes back undefined), just horizontal and integer-stepped
 * instead of a continuous 0-1 fraction of a track duration.
 *
 * Always takes the caller's full row width (own container is a column, not
 * a row alongside a text label) - `widthRef` is read from the track's own
 * onLayout, so a track squeezed down to near-zero by a sibling label in a
 * shared row (the original layout, before this component had its own full
 * line) threw off both the visible fill/knob position and the actual
 * drag-to-value math identically, since both read from the same
 * `widthRef`/fraction - there was no separate "visual" bug independent of
 * the "broken" dragging.
 */
export function CrossfadeSlider({ colors, valueSeconds, onChangeSeconds }: CrossfadeSliderProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackRef = useRef<any>(null);
  const widthRef = useRef(0);
  const pageXRef = useRef(0);
  const onChangeRef = useRef(onChangeSeconds);
  useEffect(() => {
    onChangeRef.current = onChangeSeconds;
  }, [onChangeSeconds]);

  // Live drag value, shown immediately instead of waiting for `valueSeconds`
  // to round-trip back down through props - purely visual, same idea as
  // SeekBar's previewFraction.
  const [dragValue, setDragValue] = useState<number | null>(null);
  const displayValue = dragValue ?? valueSeconds;
  const fraction = (displayValue - MIN_CROSSFADE_SECONDS) / RANGE;

  const handleLayout = (event: LayoutChangeEvent) => {
    widthRef.current = event.nativeEvent.layout.width;
    measurePageX();
  };

  const measurePageX = () => {
    trackRef.current?.measure((_x: number, _y: number, _width: number, _height: number, pageX: number) => {
      pageXRef.current = pageX;
    });
  };

  const valueFromEvent = (event: GestureResponderEvent): number | null => {
    if (widthRef.current <= 0) return null;
    const relativeX = Number.isFinite(event.nativeEvent.locationX)
      ? event.nativeEvent.locationX
      : event.nativeEvent.pageX - pageXRef.current;
    if (!Number.isFinite(relativeX)) return null;
    const rawFraction = Math.max(0, Math.min(1, relativeX / widthRef.current));
    return Math.round(MIN_CROSSFADE_SECONDS + rawFraction * RANGE);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        measurePageX();
        const value = valueFromEvent(event);
        if (value == null) return;
        setDragValue(value);
        onChangeRef.current(value);
      },
      onPanResponderMove: (event) => {
        const value = valueFromEvent(event);
        if (value == null) return;
        setDragValue(value);
        onChangeRef.current(value);
      },
      onPanResponderRelease: () => setDragValue(null),
      onPanResponderTerminate: () => setDragValue(null),
    }),
  ).current;

  return (
    <View style={styles.container}>
      <View
        ref={trackRef}
        style={[styles.track, { backgroundColor: withAlpha(colors.accent, 0.25) }]}
        onLayout={handleLayout}
        hitSlop={{ top: 14, bottom: 14, left: 4, right: 4 }}
        {...panResponder.panHandlers}
      >
        <View style={[styles.fill, { width: `${fraction * 100}%`, backgroundColor: colors.accent }]} />
        <View style={[styles.knob, { left: `${fraction * 100}%`, backgroundColor: colors.accent }]} />
      </View>
      <View style={styles.endpointsRow}>
        <Text style={[styles.endpointLabel, { color: colors.subtleText }]}>{MIN_CROSSFADE_SECONDS}s</Text>
        <Text style={[styles.endpointLabel, { color: colors.subtleText }]}>{MAX_CROSSFADE_SECONDS}s</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  track: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    // Deliberately NOT overflow:'hidden' - the knob needs to visibly poke
    // out past the track's own height, which clipping would cut off.
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
  knob: {
    position: 'absolute',
    top: '50%',
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    transform: [{ translateX: -KNOB_SIZE / 2 }, { translateY: -KNOB_SIZE / 2 }],
  },
  endpointsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  endpointLabel: {
    fontSize: 12,
  },
});
