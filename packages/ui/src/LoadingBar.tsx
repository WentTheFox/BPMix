import { useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Animated, Easing, StyleSheet } from 'react-native';

const SWEEP_DURATION_MS = 900;
const HIGHLIGHT_WIDTH_FRACTION = 0.35;

/**
 * Indeterminate loading progress bar - a highlight sweeping left-to-right
 * on a loop. Same height/shape as SeekBar, so swapping between the two
 * while a track loads (see App.tsx) doesn't reflow anything around it -
 * unlike a spinner-icon-plus-text row, this never needs its own separate
 * bit of reserved vertical space.
 *
 * Driven by translateX in pixels (via onLayout's measured width), not
 * `left` as a percentage - percentage values aren't supported by the
 * native driver, which meant this animation used to run on the JS thread
 * and visibly compete with everything else happening there (React
 * re-renders, metadata/art fetches, ...) instead of running independently
 * on the native side like the rest of the app's animations.
 */
export function LoadingBar(): React.JSX.Element {
  const [trackWidth, setTrackWidth] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;

  const handleLayout = (event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  };

  useEffect(() => {
    if (trackWidth <= 0) return;
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: SWEEP_DURATION_MS,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, trackWidth]);

  const highlightWidth = trackWidth * HIGHLIGHT_WIDTH_FRACTION;
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-highlightWidth, trackWidth],
  });

  return (
    <Animated.View style={styles.track} onLayout={handleLayout}>
      {trackWidth > 0 && (
        <Animated.View style={[styles.highlight, { width: highlightWidth, transform: [{ translateX }] }]} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 10,
    marginTop: 12,
    borderRadius: 5,
    backgroundColor: 'rgba(59, 130, 246, 0.25)',
    overflow: 'hidden',
  },
  highlight: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#3b82f6',
    borderRadius: 5,
  },
});
