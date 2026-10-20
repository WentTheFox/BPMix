import { MiniPlayerBar } from '../MiniPlayerBar';
import type { MiniPlayerBarProps } from '../MiniPlayerBar';
import { useFastDisplay } from './useFastDisplay';

export type LiveMiniPlayerBarProps = Omit<MiniPlayerBarProps, 'positionSeconds' | 'durationSeconds'> & { crossfadeSeconds: number };

/**
 * MiniPlayerBar with its position/duration subscribed to the live player
 * state here, so only this bar re-renders on each tick - not the app root.
 */
export function LiveMiniPlayerBar({ crossfadeSeconds, ...props }: LiveMiniPlayerBarProps) {
  const { displayPositionSeconds, displayDurationSeconds } = useFastDisplay(crossfadeSeconds);
  return <MiniPlayerBar {...props} positionSeconds={displayPositionSeconds} durationSeconds={displayDurationSeconds} />;
}
