import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { NATIVE_SPIN_LEG_MS, TURNS_PER_SONG } from './spinConstants';

/** How many NATIVE_SPIN_LEG_MS legs to queue in one native-driven Animated.sequence before the JS thread needs to be serviced again - see runBatch's doc. 30 legs * 20s/leg = 10 real minutes between JS round trips, comfortably past almost any single track's length. */
const LEGS_PER_BATCH = 30;

/**
 * Native (Android/iOS) disc spin - a continuously-running, native-driver
 * Animated.timing (chained in fixed-duration legs, re-timed only when
 * turnsPerSecond actually changes), NOT a per-render-tick retarget. Progress
 * arrives from React state on every ~200ms position poll, which would mean
 * either restarting/retargeting the animation that often (stutter-prone:
 * competes with the JS thread's own per-tick re-render work) or letting it
 * lag behind between polls - continuous native-thread rotation sidesteps
 * both: progress is read only to anchor the correct starting angle
 * whenever turnsPerSecond changes (play/pause, a track/duration change),
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
  // Whether the previous effect run left the disc actually spinning (rate
  // > 0) - see the reset-vs-continue branch below.
  const wasSpinningRef = useRef(false);

  useEffect(() => {
    if (turnsPerSecond <= 0) {
      // Freezes wherever the last leg's stop() below already left it -
      // reads as the record actually coming to a stop, not resetting.
      wasSpinningRef.current = false;
      return;
    }
    if (!wasSpinningRef.current) {
      // Only jump to the progress-implied angle when spinning is actually
      // starting from a stop (a fresh track, or resuming from pause, where
      // progress hasn't moved since the disc froze). A rate change while
      // ALREADY spinning - e.g. the loading placeholder rate handing off to
      // the real duration-based one once a track finishes loading - must
      // NOT re-anchor here: the disc's angle during loading isn't meant to
      // track real progress at all (progress is still ~0 the whole time),
      // so snapping to progress's angle would visibly rewind the disc by
      // however far the loading spin had already turned. Continuing from
      // wherever it already is (runBatch below reads rotationDeg's current
      // value) keeps the spin uninterrupted across that handoff.
      rotationDeg.setValue(progressRef.current * TURNS_PER_SONG * 360);
    }
    wasSpinningRef.current = true;
    const legDegrees = turnsPerSecond * 360 * (NATIVE_SPIN_LEG_MS / 1000);
    let anim: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    // Batched into one Animated.sequence rather than each leg individually
    // starting the next from its own JS completion callback (the previous
    // approach here) - useNativeDriver:true means every leg in a single
    // sequence chains entirely on the native thread with no JS round trip
    // in between, so a JS-thread hiccup right as one leg ends (a background
    // metadata-scan chunk, a GC pause, anything) can no longer leave the
    // disc visibly frozen at that leg's target angle until JS gets around
    // to starting the next one - confirmed on-device as random multi-second
    // pauses during otherwise smooth playback. JS only needs to be serviced
    // once per LEGS_PER_BATCH legs now, not once per leg.
    const runBatch = () => {
      if (cancelled) return;
      // Animated.Value has no public synchronous getter - reading the
      // private field is a well-worn, deliberate exception here (there's
      // no other way to continue an in-flight rotation from its current
      // angle instead of resetting it).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const current = (rotationDeg as any)._value ?? 0;
      // Absolute per-leg targets (current + legDegrees*(i+1)), not each leg
      // relative to the previous - avoids compounding floating-point drift
      // across a long batch.
      const legs = Array.from({ length: LEGS_PER_BATCH }, (_, i) =>
        Animated.timing(rotationDeg, {
          toValue: current + legDegrees * (i + 1),
          duration: NATIVE_SPIN_LEG_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      anim = Animated.sequence(legs);
      anim.start(({ finished }) => {
        if (finished) runBatch();
      });
    };
    runBatch();
    return () => {
      cancelled = true;
      anim?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnsPerSecond, rotationDeg]);

  const rotate = rotationDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'], extrapolate: 'extend' });
  return { transform: [{ rotate }] };
}
