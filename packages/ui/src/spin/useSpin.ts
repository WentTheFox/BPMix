import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { BASE_SPIN_MS, bucketedSpinRate } from './spinConstants';

/**
 * Wall-clock duration of each animation leg, independent of rate - NOT a
 * fixed number of turns (as this used to be): at MIN_SPIN_RATE (0.12), a
 * fixed 200-turn leg took (BASE_SPIN_MS/0.12)*200 ≈ 26.6 million ms to
 * schedule in one Animated.timing call. RN precomputes a per-frame easing
 * lookup table sized by duration/frameDuration for a timing animation even
 * under useNativeDriver, and at that duration the table's element count
 * overflowed what the engine could allocate ("Requested an array size that
 * fails to allocate") - crashing the whole app the moment a disc idled at
 * the slow end of its speed range, which is most of the time (the "next"
 * disc, until an actual crossfade brings it up to speed). A fixed leg
 * *duration* keeps the table size bounded regardless of rate; only the
 * degrees it covers (legDegrees below) scales with rate instead.
 */
const LEG_DURATION_MS = 20000;

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
    // Degrees covered by LEG_DURATION_MS at this rate - one full turn
    // (360deg) normally takes BASE_SPIN_MS/bucketedRate ms, so this is just
    // that turn rate scaled up to the fixed leg duration.
    const legDegrees = 360 * bucketedRate * (LEG_DURATION_MS / BASE_SPIN_MS);
    const legDurationMs = LEG_DURATION_MS;
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
