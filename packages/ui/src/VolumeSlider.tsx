import { useEffect, useRef, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import type { Colors } from './theme';
import { withAlpha } from './theme';

export interface VolumeSliderProps {
  colors: Colors;
  volume: number;
  onChangeVolume: (volume: number) => void;
}

const TRACK_HEIGHT = 140;
const KNOB_SIZE = 16;
/** Volume only ever lands on multiples of this (e.g. 0.02 -> 0%, 2%, 4%, ... 100%) - fewer, more deliberate stops than every possible fractional pixel position, and matches the whole-percent label exactly instead of it silently rounding a value the fill/knob didn't. */
const VOLUME_STEP = 0.02;

/**
 * A vertical fader (top = full volume, bottom = silent) - matches the shape
 * of the popover it lives in (see VolumeButton), which opens upward from a
 * small icon button and isn't wide enough for a comfortable horizontal
 * track. Tap-or-drag, via PanResponder (mirroring SeekBar's own approach)
 * rather than a plain Pressable's onPress - a Pressable only fires once,
 * on release, and only if the finger is still over it then, which read as
 * both unresponsive (nothing happens until you lift your finger) and
 * jumpy (a drag that wanders outside the narrow 10px track - easy to do
 * dragging vertically - loses the gesture entirely). PanResponder keeps
 * receiving move events regardless of whether the touch point is still
 * over the track, so onChangeVolume fires continuously and dragging past
 * either end just clamps instead of misbehaving.
 *
 * Unlike SeekBar, this calls onChangeVolume on every move tick with no
 * debounce at all: setVolume() only calls the current source's setGain(),
 * never tearing down/recreating a native source the way seek() does, so
 * there's no native-source-churn crash risk here to throttle against.
 */
export function VolumeSlider({ colors, volume, onChangeVolume }: VolumeSliderProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackRef = useRef<any>(null);
  const heightRef = useRef(0);
  const pageYRef = useRef(0);
  const onChangeVolumeRef = useRef(onChangeVolume);
  useEffect(() => {
    onChangeVolumeRef.current = onChangeVolume;
  }, [onChangeVolume]);

  // Live drag position, shown immediately instead of waiting for `volume`
  // to round-trip back down through props - purely visual, same idea as
  // SeekBar's previewFraction.
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const displayVolume = dragFraction ?? volume;

  const measureTrack = () => {
    trackRef.current?.measure((_x: number, _y: number, _width: number, height: number, _pageX: number, pageY: number) => {
      heightRef.current = height;
      pageYRef.current = pageY;
    });
  };

  const handleLayout = (_event: LayoutChangeEvent) => {
    measureTrack();
  };

  const fractionFromEvent = (event: GestureResponderEvent): number | null => {
    if (heightRef.current <= 0) return null;
    // Always pageY minus the measured top, never locationY - unlike a tap,
    // a drag routinely carries the touch outside this track's narrow
    // (10px-wide) bounds, and RN's locationY is computed by re-hit-testing
    // the CURRENT touch point against the view tree on every move event,
    // not locked to the view that originally became the responder - once
    // the finger leaves this element, locationY starts reporting a
    // coordinate relative to whatever unrelated view is now underneath it
    // instead, producing exactly the jumpy/backwards behavior confirmed
    // on-device. pageY is an absolute screen coordinate regardless of
    // what's hit-tested, so subtracting the track's own measured page
    // offset (captured once, at grant) stays correct however far outside
    // the track the drag wanders.
    const relativeY = event.nativeEvent.pageY - pageYRef.current;
    if (!Number.isFinite(relativeY)) return null;
    // Inverted (top = full, bottom = silent) and clamped - dragging past
    // either end of the track just pins to that end instead of losing the
    // gesture or jumping erratically.
    const fraction = Math.max(0, Math.min(1, 1 - relativeY / heightRef.current));
    // Snapped to VOLUME_STEP - rounding (not floor/ceil) so the value jumps
    // to whichever step is actually closer to the raw touch position.
    return Math.round(fraction / VOLUME_STEP) * VOLUME_STEP;
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        measureTrack();
        const fraction = fractionFromEvent(event);
        if (fraction == null) return;
        setDragFraction(fraction);
        onChangeVolumeRef.current(fraction);
      },
      onPanResponderMove: (event) => {
        const fraction = fractionFromEvent(event);
        if (fraction == null) return;
        setDragFraction(fraction);
        onChangeVolumeRef.current(fraction);
      },
      onPanResponderRelease: () => setDragFraction(null),
      onPanResponderTerminate: () => setDragFraction(null),
    }),
  ).current;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.subtleText }]}>{Math.round(displayVolume * 100)}%</Text>
      <View
        ref={trackRef}
        style={[styles.track, { backgroundColor: withAlpha(colors.accent, 0.25) }]}
        onLayout={handleLayout}
        hitSlop={{ top: 4, bottom: 4, left: 14, right: 14 }}
        {...panResponder.panHandlers}
      >
        <View style={[styles.fill, { height: `${displayVolume * 100}%`, backgroundColor: colors.accent }]} />
        {/* Sits at the fill's top edge, shifted up by half its own (fixed) size to center on that edge rather than sit entirely below it - a round knob signals "this is draggable" the way a bare filled track doesn't. */}
        <View style={[styles.knob, { bottom: `${displayVolume * 100}%`, backgroundColor: colors.accent }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 11,
  },
  track: {
    width: 10,
    height: TRACK_HEIGHT,
    borderRadius: 5,
    // flex-end anchors `fill` to the BOTTOM of the track - without it, a
    // column flex container's default alignment puts fill (a fixed-height
    // child) at the top instead, so it grew downward from full volume
    // rather than upward from empty, reading backwards (confirmed
    // on-device).
    justifyContent: 'flex-end',
    // Deliberately NOT overflow:'hidden' (unlike SeekBar's track) - the
    // knob needs to visibly poke out past the track's own width, which
    // clipping would cut off.
  },
  fill: {
    width: '100%',
    borderRadius: 5,
  },
  knob: {
    position: 'absolute',
    left: '50%',
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    transform: [{ translateX: -KNOB_SIZE / 2 }, { translateY: KNOB_SIZE / 2 }],
  },
});
