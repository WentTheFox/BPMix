import { useRef } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export interface VolumeSliderProps {
  volume: number;
  onChangeVolume: (volume: number) => void;
}

/**
 * Tap-to-set, mirroring SeekBar's own approach (see its doc) for
 * consistency - though unlike seeking, dragging a volume slider wouldn't
 * actually hit the native-source-churn crash risk that ruled out drag-to-
 * scrub there (setVolume() just calls the existing source's setGain(), it
 * never tears down/recreates a source the way seek() does), so drag support
 * could be added here later without that same concern.
 */
export function VolumeSlider({ volume, onChangeVolume }: VolumeSliderProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trackRef = useRef<any>(null);
  const widthRef = useRef(0);
  const pageXRef = useRef(0);

  const measureTrack = () => {
    trackRef.current?.measure((_x: number, _y: number, width: number, _height: number, pageX: number) => {
      widthRef.current = width;
      pageXRef.current = pageX;
    });
  };

  const handleLayout = (_event: LayoutChangeEvent) => {
    measureTrack();
  };

  const handlePress = (event: GestureResponderEvent) => {
    if (widthRef.current <= 0) return;
    const relativeX = Number.isFinite(event.nativeEvent.locationX)
      ? event.nativeEvent.locationX
      : event.nativeEvent.pageX - pageXRef.current;
    if (!Number.isFinite(relativeX)) return;
    onChangeVolume(Math.max(0, Math.min(1, relativeX / widthRef.current)));
  };

  return (
    <View style={styles.volumeRow}>
      <Text style={styles.volumeLabel}>Volume</Text>
      <Pressable
        ref={trackRef}
        style={[styles.seekBarTrack, styles.volumeTrack]}
        onLayout={handleLayout}
        onPress={handlePress}
        hitSlop={{ top: 14, bottom: 14, left: 4, right: 4 }}
      >
        <View style={[styles.seekBarFill, { width: `${volume * 100}%` }]} />
      </Pressable>
      <Text style={styles.volumeLabel}>{Math.round(volume * 100)}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  seekBarTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(59, 130, 246, 0.25)',
    overflow: 'hidden',
  },
  seekBarFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  volumeLabel: {
    color: '#999',
    fontSize: 11,
    minWidth: 34,
  },
  volumeTrack: {
    flex: 1,
  },
});
