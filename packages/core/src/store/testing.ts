import type { PlaylistPlayerState } from '../playback/playlistPlayer';
import { LivePlayback } from './playback/livePlayback';

/** What a player with nothing loaded reports. */
export const idlePlayerState = (over: Partial<PlaylistPlayerState> = {}): PlaylistPlayerState => ({
  totalTracks: 0,
  position: -1,
  currentFileId: null,
  loopMode: 'off',
  shuffleEnabled: false,
  track: { status: 'idle', isAudible: false, positionSeconds: 0, durationSeconds: 0, pendingIncoming: null },
  pendingCrossfadeFileIds: null,
  isLoadingForPlayback: false,
  ...over,
});

/** A LivePlayback over a fake player whose state tests can swap via `setState`. */
export function fakeLivePlayback(initial: PlaylistPlayerState = idlePlayerState()) {
  let state = initial;
  const live = new LivePlayback({ getState: () => state });
  return { live, setState: (next: PlaylistPlayerState) => void (state = next) };
}
