import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';

const SWEEP_DURATION_MS = 900;
const HIGHLIGHT_WIDTH_FRACTION = 0.35;

/**
 * Indeterminate loading progress bar - a highlight sweeping left-to-right
 * on a loop. Same height/shape as SeekBar, so swapping between the two
 * while a track loads (see App.tsx) doesn't reflow anything around it -
 * unlike a spinner-icon-plus-text row, this never needs its own separate
 * bit of reserved vertical space.
 */
export function LoadingBar(): React.JSX.Element {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: SWEEP_DURATION_MS,
        easing: Easing.inOut(Easing.ease),
        // `left` as a percentage string isn't supported by the native
        // driver - this animation is cheap/low-frequency enough that
        // running it on the JS thread is fine.
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  const left = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [`-${HIGHLIGHT_WIDTH_FRACTION * 100}%`, '100%'],
  });

  return (
    <Animated.View style={styles.track}>
      <Animated.View style={[styles.highlight, { left, width: `${HIGHLIGHT_WIDTH_FRACTION * 100}%` }]} />
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
    backgroundColor: '#3b82f6',
    borderRadius: 5,
  },
});
