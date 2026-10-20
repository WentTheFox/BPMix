import { NowPlayingScreen } from '../NowPlayingScreen';
import type { NowPlayingScreenProps } from '../NowPlayingScreen';
import { useFastDisplay } from './useFastDisplay';

export type LiveNowPlayingScreenProps = Omit<
  NowPlayingScreenProps,
  'currentGain' | 'currentProgress' | 'nextGain' | 'positionSeconds' | 'durationSeconds'
> & { crossfadeSeconds: number };

/**
 * NowPlayingScreen with its position, duration and crossfade art values
 * subscribed to the live player state here, so only this screen re-renders on
 * each tick - not the app root.
 */
export function LiveNowPlayingScreen({ crossfadeSeconds, ...props }: LiveNowPlayingScreenProps) {
  const { displayPositionSeconds, displayDurationSeconds, outgoingGain, outgoingProgress, incomingGain } = useFastDisplay(crossfadeSeconds);
  return (
    <NowPlayingScreen
      {...props}
      currentGain={outgoingGain}
      currentProgress={outgoingProgress}
      nextGain={incomingGain}
      positionSeconds={displayPositionSeconds}
      durationSeconds={displayDurationSeconds}
    />
  );
}
