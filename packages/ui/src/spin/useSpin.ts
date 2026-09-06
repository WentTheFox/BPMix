import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { NATIVE_SPIN_LEG_MS, TURNS_PER_SONG } from './spinConstants';

/**
 * Native (Android/iOS) disc spin - a continuously-running, native-driver
 * Animated.timing (chained in fixed-duration legs, re-timed only when
 * turnsPerSecond actually changes), NOT a per-render-tick retarget. Progress
 * arrives from React state on every ~200ms position poll, which would mean
 * either restarting/retargeting the animation that often (stutter-prone:
 * competes with the JS thread's own per-tick re-render work) or letting it
 * lag behind between polls - continuous native-thread rotation sidesteps
 * both: progress is read only to anchor the correct starting angle
 * whenever turnsPerSecond changes (play/pause, a scrub starting/ending),
 * not on every tick along the way.
 */
export function useSpin(
  turnsPerSecond: number,
  progress: number,
  // Unused here - only useSpin.web.ts's CSS approach needs a stable identity
  // to persist the current rotation angle across a disc's unmount/remount
  // (e.g. the current-slot disc unmounting for a transition's duration).
  // Kept as a parameter anyway so CrossfadeArt.tsx can call this hook the
  // same way regardless of platform.
  _spinId: string,
): { transform: Array<{ rotate: Animated.AnimatedInterpolation<string> }> } {
  const anchorDeg = progress * TURNS_PER_SONG * 360;
  const rotationDeg = useRef(new Animated.Value(anchorDeg)).current;
  // Re-anchors (jumps to the angle progress now implies) only when the
  // rate itself changes - a mid-leg progress update on its own must NOT
  // retrigger this, or every ~200ms poll would restart the animation from
  // scratch, defeating the whole point of running it continuously.
  const progressRef = useRef(progress);
  progressRef.current = progress;

  useEffect(() => {
    if (turnsPerSecond <= 0) {
      // Freezes wherever the last leg's stop() below already left it -
      // reads as the record actually coming to a stop, not resetting.
      return;
    }
    rotationDeg.setValue(progressRef.current * TURNS_PER_SONG * 360);
    const legDegrees = turnsPerSecond * 360 * (NATIVE_SPIN_LEG_MS / 1000);
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
        duration: NATIVE_SPIN_LEG_MS,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnsPerSecond, rotationDeg]);

  const rotate = rotationDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'], extrapolate: 'extend' });
  return { transform: [{ rotate }] };
}
