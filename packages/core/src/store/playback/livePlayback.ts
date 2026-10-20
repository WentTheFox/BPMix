import type { PlaylistPlayerState } from '../../playback/playlistPlayer';

/**
 * The player's full state, including the fast-moving parts (position,
 * crossfade progress), as a subscribable snapshot - the single place the
 * UI reads it from. Deliberately NOT redux state: positions change ~5 times
 * a second, and routing every tick through the store would re-run every
 * selector for nothing. The store instead mirrors only the coarse fields
 * (see playbackSlice) that change when something meaningful happens.
 *
 * `getSnapshot`/`subscribe` are arrow properties so they can be handed
 * straight to useSyncExternalStore.
 */
export class LivePlayback {
  private snapshot: PlaylistPlayerState;
  private readonly listeners = new Set<(state: PlaylistPlayerState) => void>();

  constructor(private readonly player: { getState(): PlaylistPlayerState }) {
    this.snapshot = player.getState();
  }

  getSnapshot = (): PlaylistPlayerState => this.snapshot;

  subscribe = (listener: (state: PlaylistPlayerState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Re-reads the player (or takes `state`, if the caller already has it) and notifies subscribers. Call after anything that changed it, or on the ticker. */
  publish(state: PlaylistPlayerState = this.player.getState()): PlaylistPlayerState {
    this.snapshot = state;
    for (const listener of this.listeners) listener(state);
    return state;
  }
}
