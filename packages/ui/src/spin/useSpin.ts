import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { SPIN_UPDATE_MS, TURNS_PER_SONG } from './spinConstants';

/**
 * Native (Android/iOS) disc spin - a plain Animated.timing eased toward
 * whatever angle the current progress implies, retimed each time progress
 * changes. Previously this was an open-ended, rate-driven animation
 * (chained legs that had to keep re-timing themselves as gain changed) -
 * tying rotation directly to progress instead means the angle is always
 * exactly consistent with playback position, freezes for free on pause
 * (progress just stops updating), and can't runaway into an absurd
 * duration at a slow rate the way the old leg system did (see git history
 * for the array-allocation crash that caused - MIN_SPIN_RATE's leg
 * duration at 200 turns/leg came out to ~26.6 million ms, which blew out
 * the easing lookup table RN precomputes for a timing animation).
 */
export function useSpin(
  progress: number,
  // Unused here - only useSpin.web.ts's CSS approach needs a stable identity
  // to persist the current rotation angle across a disc's unmount/remount
  // (e.g. the current-slot disc unmounting for a transition's duration).
  // Kept as a parameter anyway so CrossfadeArt.tsx can call this hook the
  // same way regardless of platform.
  _spinId: string,
): { transform: Array<{ rotate: Animated.AnimatedInterpolation<string> }> } {
  const targetDeg = progress * TURNS_PER_SONG * 360;
  const rotationDeg = useRef(new Animated.Value(targetDeg)).current;
  useEffect(() => {
    Animated.timing(rotationDeg, { toValue: targetDeg, duration: SPIN_UPDATE_MS, easing: Easing.linear, useNativeDriver: true }).start();
  }, [targetDeg, rotationDeg]);
  const rotate = rotationDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'], extrapolate: 'extend' });
  return { transform: [{ rotate }] };
}
