import type { PlaylistPlayer, PlaylistPlayerState } from '../../playback/playlistPlayer';
import type { LivePlayback } from './livePlayback';

/** How often playback state is re-read while something is active. */
export const PLAYBACK_TICK_MS = 200;

/**
 * Whether the player has anything that moves on its own: a playing track, a
 * decode in flight (which finishes asynchronously, with no event to hear it
 * by), or a crossfade. Paused/idle state only changes through an explicit
 * command, and every command publishes - so there's nothing to poll for.
 */
export function isPlaybackActive(state: PlaylistPlayerState): boolean {
  return state.track.status === 'playing' || state.track.status === 'loading' || state.track.pendingIncoming != null;
}

export interface PlaybackTickerOptions {
  livePlayback: LivePlayback;
  playlistPlayer: Pick<PlaylistPlayer, 'checkPreload'>;
  /** Runs after each tick's publish, with the state it published (e.g. throttled position persistence). */
  onTick?: (state: PlaylistPlayerState) => void;
  intervalMs?: number;
}

/**
 * The player has no event stream for position, so this polls it - but only
 * while it's active (see isPlaybackActive), starting whenever a published
 * state is active and stopping on the first tick that finds it isn't. Each
 * tick publishes the fresh state, drives the preload/crossfade scheduler
 * (which reuses this tick rather than running a second timer), then reports.
 * A service, not a component effect: nothing in React owns it. Returns a stop
 * function.
 */
export function startPlaybackTicker({ livePlayback, playlistPlayer, onTick, intervalMs = PLAYBACK_TICK_MS }: PlaybackTickerOptions): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;

  const stopInterval = () => {
    if (interval !== null) clearInterval(interval);
    interval = null;
  };

  const tick = () => {
    const state = livePlayback.publish();
    playlistPlayer.checkPreload();
    onTick?.(state);
    if (!isPlaybackActive(state)) stopInterval();
  };

  const ensureRunning = (state: PlaylistPlayerState) => {
    if (interval === null && isPlaybackActive(state)) interval = setInterval(tick, intervalMs);
  };

  const unsubscribe = livePlayback.subscribe(ensureRunning);
  ensureRunning(livePlayback.getSnapshot());
  return () => {
    unsubscribe();
    stopInterval();
  };
}
