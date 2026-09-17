import { StyleSheet, Text, View } from 'react-native';
import type { Colors } from '../theme';
import { withAlpha } from '../theme';
import { useDraggableSliderValue } from '../useDraggableSliderValue';

export interface HorizontalVolumeSliderProps {
  colors: Colors;
  volume: number;
  onChangeVolume: (volume: number) => void;
}

const KNOB_SIZE = 20;

/**
 * Horizontal counterpart to VolumeSlider (that one's vertical, sized for
 * VolumeButton's small popover) - the Settings screen's own volume row sits
 * in a vertical list of full-width controls alongside CrossfadeSlider, so it
 * needs that same horizontal shape rather than the popover's narrow fader.
 * Drag gesture (including the gesture-damping that lets a slowed-down drag
 * land on one exact percentage) comes from useDraggableSliderValue, shared
 * with VolumeSlider so the two can't drift into feeling different from each
 * other - CrossfadeSlider's own drag logic stays separate since it steps in
 * whole seconds across a fixed range, different enough value math that
 * sharing just the touch-tracking would leave it passing in almost as much
 * logic as it removed.
 */
export function HorizontalVolumeSlider({ colors, volume, onChangeVolume }: HorizontalVolumeSliderProps) {
  const { trackRef, displayValue, onLayout, panHandlers } = useDraggableSliderValue({
    axis: 'horizontal',
    value: volume,
    onChangeValue: onChangeVolume,
  });

  return (
    <View style={styles.container}>
      <View
        ref={trackRef}
        style={[styles.track, { backgroundColor: withAlpha(colors.accent, 0.25) }]}
        onLayout={onLayout}
        hitSlop={{ top: 14, bottom: 14, left: 4, right: 4 }}
        {...panHandlers}
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
