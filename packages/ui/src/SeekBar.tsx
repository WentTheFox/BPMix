import { useRef } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { Pressable, StyleSheet, View } from 'react-native';

export interface SeekBarProps {
  positionSeconds: number;
  durationSeconds: number;
  onSeekTo: (positionSeconds: number) => void;
}

/**
 * Tap-to-seek only, deliberately not drag-to-scrub: a drag would need to
 * call seek() continuously as the finger/mouse moves, which is exactly the
 * rapid-fire native-source-churn pattern that crashes react-native-audio-api
 * on Android. A tap fires exactly one seek() call, same as any other
 * transport button.
 */
export function SeekBar({ positionSeconds, durationSeconds, onSeekTo }: SeekBarProps) {
  // event.nativeEvent.locationX is unreliable on react-native-web (comes
  // back undefined there, unlike native RN) - measure() + pageX works on
  // both, so that's used instead of locationX everywhere.
  // Typed loosely: RN's own ref type here (ReactNativeElement) isn't a
  // public export, and this is a narrow, self-contained use of .measure().
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
    if (widthRef.current <= 0 || durationSeconds <= 0) return;
    // Prefer locationX (element-relative, no measure() dependency) when
    // it's actually a usable number - true on native RN. Falls back to
    // pageX minus the measured element offset, since locationX comes back
    // undefined on react-native-web.
    const relativeX = Number.isFinite(event.nativeEvent.locationX)
      ? event.nativeEvent.locationX
      : event.nativeEvent.pageX - pageXRef.current;
    if (!Number.isFinite(relativeX)) return;
    const fraction = Math.max(0, Math.min(1, relativeX / widthRef.current));
    onSeekTo(fraction * durationSeconds);
  };

  const fillFraction = durationSeconds > 0 ? Math.max(0, Math.min(1, positionSeconds / durationSeconds)) : 0;

  return (
    <Pressable
      ref={trackRef}
      style={styles.seekBarTrack}
      onLayout={handleLayout}
      onPress={handlePress}
      hitSlop={{ top: 14, bottom: 14, left: 4, right: 4 }}
    >
      <View style={[styles.seekBarFill, { width: `${fillFraction * 100}%` }]} />
    </Pressable>
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
});
