import { useMemo } from 'react';
import { SPIN_UPDATE_MS, TURNS_PER_SONG } from './spinConstants';

/**
 * Web disc spin - a plain CSS transition to whatever angle the current
 * progress implies, instead of a continuously-running @keyframes
 * animation. Progress is deterministic (unlike the old open-ended,
 * rate-driven spin), so there's no ongoing animation to keep alive or
 * re-anchor across a remount - just retarget the transform and let the
 * browser's compositor ease to it, same idea as useSpin.ts's
 * Animated.timing.
 */
export function useSpin(progress: number, _spinId: string): object {
  return useMemo(() => {
    const deg = progress * TURNS_PER_SONG * 360;
    return {
      transform: [{ rotate: `${deg}deg` }],
      transitionProperty: 'transform',
      transitionDuration: `${SPIN_UPDATE_MS}ms`,
      transitionTimingFunction: 'linear',
    };
  }, [progress]);
}
