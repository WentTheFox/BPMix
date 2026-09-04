import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { BASE_SPIN_MS, bucketedSpinRate } from './spinConstants';

/** How many full turns to schedule per animation leg - just needs to be long enough that a rate-bucket change (or a lap completing) is very unlikely to still be running the same leg by the time the next one's scheduled; each leg's actual duration still scales with the current rate. */
const TURNS_PER_LEG = 200;

/**
 * Native (Android/iOS) disc spin - a continuously-advancing Animated.Value
 * driven by chained Animated.timing legs, restarted (re-timed, not reset)
 * whenever the rate bucket changes. See useSpin.web.ts for the CSS-driven
 * equivalent used on web instead of this JS-driven approach.
 */
export function useSpin(
  rate: number,
  // Unused here - only useSpin.web.ts's CSS approach needs a stable identity
  // to persist the current rotation angle across a disc's unmount/remount
  // (e.g. the current-slot disc unmounting for a transition's duration).
  // Kept as a parameter anyway so CrossfadeArt.tsx can call this hook the
  // same way regardless of platform.
  _spinId: string,
): { transform: Array<{ rotate: Animated.AnimatedInterpolation<string> }> } {
  // Degrees, unbounded (not normalized to [0,1] and reset every lap) - a
  // rate change re-times the animation but always continues forward from
  // wherever the disc's angle already is, instead of snapping back to 0.
  // Resetting the value on every rate-bucket change (which happens
  // constantly while a track is loading, as gain/isPlaying settle) is
  // exactly what caused the disc to visibly jump back to "straight up"
  // and restart mid-spin.
  const rotationDeg = useRef(new Animated.Value(0)).current;
  const bucketedRate = bucketedSpinRate(rate);
  useEffect(() => {
    if (bucketedRate <= 0) {
      // Freezes wherever the last leg's stop() below already left it -
      // reads as the record actually coming to a stop, not resetting.
      return;
    }
    const legDegrees = TURNS_PER_LEG * 360;
    const legDurationMs = (BASE_SPIN_MS / bucketedRate) * TURNS_PER_LEG;
    let anim: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    const runLeg = () => {
      if (cancelled) return;
      // Animated.Value has no public synchronous getter - reading the
      // private field is a well-worn, deliberate exception here (there's
      // no other way to continue an in-flight rotation from its current
      // angle instead of resetting it).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const current = (rotationDeg as any)._value ?? 0;
      anim = Animated.timing(rotationDeg, {
        toValue: current + legDegrees,
        duration: legDurationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      });
      anim.start(({ finished }) => {
        if (finished) runLeg();
      });
    };
    runLeg();
    return () => {
      cancelled = true;
      anim?.stop();
    };
  }, [bucketedRate, rotationDeg]);
  const rotate = rotationDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'], extrapolate: 'extend' });
  return { transform: [{ rotate }] };
}
