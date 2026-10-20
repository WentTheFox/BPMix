import { computeFastDisplay } from '@bpmix/core';
import type { FastDisplay } from '@bpmix/core';
import { useMemo } from 'react';
import { useLivePlayerState } from './useLivePlayerState';

/** The fast-moving display values (position, progress, crossfade gains) - see computeFastDisplay. Re-renders the caller every tick: use it only in leaf components. */
export function useFastDisplay(crossfadeSeconds: number): FastDisplay {
  const state = useLivePlayerState();
  return useMemo(() => computeFastDisplay(state, crossfadeSeconds), [state, crossfadeSeconds]);
}
