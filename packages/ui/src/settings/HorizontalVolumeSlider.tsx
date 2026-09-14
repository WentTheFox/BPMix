import { useEffect, useRef, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';

export interface HorizontalVolumeSliderProps {
  colors: Colors;
  volume: number;
  onChangeVolume: (volume: number) => void;
}

const KNOB_SIZE = 20;
/** Matches VolumeSlider's own step (the Now Playing screen's vertical popover fader) so dragging either one lands on the same set of values. */
const VOLUME_STEP = 0.02;

/**
 * Horizontal counterpart to VolumeSlider (that one's vertical, sized for
 * VolumeButton's small popover) - the Settings screen's own volume row sits
 * in a vertical list of full-width controls alongside CrossfadeSlider, so it
 * needs that same horizontal shape rather than the popover's narrow fader.
 * Tap-or-drag PanResponder logic is copied from CrossfadeSlider's (locationX
 * where available, falling back to pageX minus the track's measured offset
 * for react-native-web) rather than shared, since crossfade steps in whole
 * seconds across a fixed range while this steps in VOLUME_STEP across [0,1] -
 * different enough value math that factoring out just the touch-tracking
 * would leave two callers passing in almost as much logic as it removed.
 */
export function HorizontalVolumeSlider({ colors, volume, onChangeVolume }: HorizontalVolumeSliderProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackRef = useRef<any>(null);
  const widthRef = useRef(0);
  const pageXRef = useRef(0);
  const onChangeRef = useRef(onChangeVolume);
  useEffect(() => {
    onChangeRef.current = onChangeVolume;
  }, [onChangeVolume]);

  // Live drag position, shown immediately instead of waiting for `volume` to
  // round-trip back down through props - same idea as CrossfadeSlider's
  // dragValue/SeekBar's previewFraction.
  const [dragValue, setDragValue] = useState<number | null>(null);
  const displayValue = dragValue ?? volume;

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
    const relativeX = Number.isFinite(event.nativeEvent.locationX) ? event.nativeEvent.locationX : event.nativeEvent.pageX - pageXRef.current;
    if (!Number.isFinite(relativeX)) return null;
    const fraction = Math.max(0, Math.min(1, relativeX / widthRef.current));
    return Math.round(fraction / VOLUME_STEP) * VOLUME_STEP;
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
        <View style={[styles.fill, { width: `${displayValue * 100}%`, backgroundColor: colors.accent }]} />
        <View style={[styles.knob, { left: `${displayValue * 100}%`, backgroundColor: colors.accent }]} />
      </View>
      <View style={styles.endpointsRow}>
        <Text style={[styles.endpointLabel, { color: colors.subtleText }]}>0%</Text>
        <Text style={[styles.endpointLabel, { color: colors.subtleText }]}>100%</Text>
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
