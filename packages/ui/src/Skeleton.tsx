import { useEffect } from 'react';
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

const PULSE_DURATION_MS = 700;

/**
 * One shared pulse driving every Skeleton on screen, rather than each
 * instance running its own independent Animated.loop - with a large
 * still-scanning library, dozens of rows can be showing skeletons at once
 * (art + artist line per row), and that many independent timer-driven
 * loops competing for the thread (particularly on Windows, where the
 * native animation driver isn't as mature as iOS/Android's) was
 * noticeably slowing down scrolling. A single shared Animated.Value costs
 * one loop no matter how many Skeletons are mounted - Animated.Value is
 * just a listener list, so every <Animated.View> reading it is free to
 * share the same instance.
 */
const sharedPulse = new Animated.Value(0.3);
let loopStarted = false;
function ensureLoopStarted(): void {
  if (loopStarted) return;
  loopStarted = true;
  Animated.loop(
    Animated.sequence([
      Animated.timing(sharedPulse, { toValue: 0.7, duration: PULSE_DURATION_MS, useNativeDriver: true }),
      Animated.timing(sharedPulse, { toValue: 0.3, duration: PULSE_DURATION_MS, useNativeDriver: true }),
    ]),
  ).start();
}

export interface SkeletonProps {
  style?: StyleProp<ViewStyle>;
}

/**
 * A pulsing placeholder rectangle for content that's genuinely still
 * loading - distinct from a static empty placeholder (which reads as
 * "this is confirmed empty", not "wait for it"). Shared wherever a row
 * needs to show that more is coming without yet knowing what.
 */
export function Skeleton({ style }: SkeletonProps): React.JSX.Element {
  useEffect(() => {
    ensureLoopStarted();
  }, []);
  return <Animated.View style={[styles.base, style, { opacity: sharedPulse }]} />;
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: 'rgba(128,128,128,0.4)',
    borderRadius: 4,
  },
});
