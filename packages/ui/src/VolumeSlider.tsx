import { StyleSheet, Text, View } from 'react-native';
import type { Colors } from './theme';
import { withAlpha } from './theme';
import { useDraggableSliderValue } from './useDraggableSliderValue';

export interface VolumeSliderProps {
  colors: Colors;
  volume: number;
  onChangeVolume: (volume: number) => void;
}

const TRACK_HEIGHT = 140;
const KNOB_SIZE = 16;

/**
 * A vertical fader (top = full volume, bottom = silent) - matches the shape
 * of the popover it lives in (see VolumeButton), which opens upward from a
 * small icon button and isn't wide enough for a comfortable horizontal
 * track. Tap-or-drag, via useDraggableSliderValue (see its own doc for the
 * gesture-damping this gets for free - a slowed-to-a-crawl drag creeps
 * toward one exact percentage instead of hopping across the old hard
 * VOLUME_STEP grid) rather than a plain Pressable's onPress - a Pressable
 * only fires once, on release, and only if the finger is still over it
 * then, which read as both unresponsive (nothing happens until you lift
 * your finger) and jumpy (a drag that wanders outside the narrow 10px
 * track - easy to do dragging vertically - loses the gesture entirely).
 *
 * Unlike SeekBar, this calls onChangeVolume on every move tick with no
 * debounce at all: setVolume() only calls the current source's setGain(),
 * never tearing down/recreating a native source the way seek() does, so
 * there's no native-source-churn crash risk here to throttle against.
 */
export function VolumeSlider({ colors, volume, onChangeVolume }: VolumeSliderProps) {
  const { trackRef, displayValue, onLayout, panHandlers } = useDraggableSliderValue({
    axis: 'vertical',
    value: volume,
    onChangeValue: onChangeVolume,
  });

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.subtleText }]}>{Math.round(displayValue * 100)}%</Text>
      <View
        ref={trackRef}
        style={[styles.track, { backgroundColor: withAlpha(colors.accent, 0.25) }]}
        onLayout={onLayout}
        hitSlop={{ top: 4, bottom: 4, left: 14, right: 14 }}
        {...panHandlers}
      >
        <View style={[styles.fill, { height: `${displayValue * 100}%`, backgroundColor: colors.accent }]} />
        {/* Sits at the fill's top edge, shifted up by half its own (fixed) size to center on that edge rather than sit entirely below it - a round knob signals "this is draggable" the way a bare filled track doesn't. */}
        <View style={[styles.knob, { bottom: `${displayValue * 100}%`, backgroundColor: colors.accent }]} />
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
