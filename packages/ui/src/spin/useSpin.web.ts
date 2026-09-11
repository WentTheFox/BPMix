import { useMemo, useRef } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { TURNS_PER_SONG } from './spinConstants';

/**
 * A single, static @keyframes rotation shared by every spinning disc -
 * only animationDuration/animationDelay (set per-disc below) ever change,
 * so one keyframe definition is all that's needed.
 */
const SPIN_KEYFRAMES = [{ '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } }];

/** @types/react-native's ViewStyle has no idea about react-native-web's animationKeyframes/animation* style extensions - this is the real shape StyleSheet.create() accepts on web, just not one @types/react-native knows about. */
type WebSpinStyle = ViewStyle & {
  animationKeyframes: unknown;
  animationDuration: string;
  animationDelay: string;
  animationTimingFunction: string;
  animationIterationCount: string;
};

function webSpinStyle(durationMs: number, delayMs: number): WebSpinStyle {
  return {
    animationKeyframes: SPIN_KEYFRAMES,
    animationDuration: `${durationMs}ms`,
    animationDelay: `${delayMs}ms`,
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  } as WebSpinStyle;
}

/**
 * Web disc spin - a plain CSS `animation` (react-native-web's
 * `animationKeyframes` style, which compiles down to a real @keyframes
 * rule) running continuously at whatever turnsPerSecond implies, instead
 * of a JS-driven Animated.Value retargeted on every progress update. Only
 * animationDuration and a negative animationDelay (used to start the
 * animation as if it had already been running - see delayMs below) ever
 * change, and only when turnsPerSecond itself changes (play/pause, a
 * track/duration change) - progress is read only to compute that starting
 * angle, not on every ~200ms poll tick, so a rate that hasn't changed
 * keeps running untouched entirely on the browser's compositor thread.
 */
export function useSpin(turnsPerSecond: number, progress: number, _spinId: string): object {
  const durationMs = turnsPerSecond > 0 ? 1000 / turnsPerSecond : 0;

  // Tracks the real angle/rate/timestamp of whatever segment is currently
  // running, so a rate change while ALREADY spinning (e.g. the loading
  // placeholder rate handing off to the real duration-based one) can
  // continue from wherever the disc actually is instead of jumping to
  // progress's angle - see the branch below and useSpin.ts's matching
  // wasSpinningRef for why: progress stays ~0 for the whole loading spin,
  // so anchoring to it here would visibly rewind the disc by however far
  // that placeholder spin had already turned.
  const segmentRef = useRef({ rate: 0, angleDeg: 0, startedAtMs: Date.now() });

  // Recomputed only when durationMs actually changes (useMemo's whole
  // point here), reading whatever progress is current AT that moment -
  // spinId isn't used for anything here, but every call site supplies one
  // (see useSpin.ts, which does need it) so both platforms share a call
  // shape.
  return useMemo(() => {
    const prev = segmentRef.current;
    const angleNow =
      prev.rate > 0
        ? prev.angleDeg + prev.rate * 360 * ((Date.now() - prev.startedAtMs) / 1000)
        : // Was frozen (or this is the very first run) - progress is the only
          // source of truth for the angle in that case, same as the native
          // version's reset-from-a-stop branch.
          progress * TURNS_PER_SONG * 360;
    segmentRef.current = { rate: turnsPerSecond, angleDeg: angleNow, startedAtMs: Date.now() };

    if (durationMs <= 0) {
      // Not spinning at all - freeze wherever it actually is, same as the
      // native version's "return early, leave the Animated.Value alone".
      return { transform: [{ rotate: `${angleNow}deg` }] };
    }

    // A negative delay starts the animation as if it had already been
    // running for that long - i.e. already angleNow/360 of the way through
    // - so it picks up exactly where the disc already is instead of
    // restarting from 0deg.
    const delayMs = -(angleNow / 360) * durationMs;
    // react-native-web only expands `animationKeyframes` into a real
    // `@keyframes` rule (with a matching `animation-name`) for a style that
    // goes through StyleSheet.create()'s "classic" path - a plain object
    // merged into the `style` array at render time takes the "atomic" path
    // instead, which explicitly doesn't support animationKeyframes at all
    // (confirmed live: every other animation-* property landed in the DOM,
    // animation-name never did, so the disc sat frozen despite everything
    // else "running"). Calling create() here every time durationMs changes
    // (not on every render - see the useMemo/eslint-disable below) is the
    // same pattern react-native-web's own ActivityIndicator uses.
    return StyleSheet.create({ spin: webSpinStyle(durationMs, delayMs) }).spin;
    // Only turnsPerSecond (via durationMs) should ever retime this - a
    // fresh progress on its own (unchanged rate) must NOT, or every
    // ~200ms poll tick would restart the animation from scratch, defeating
    // the whole point of running it continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs]);
}
