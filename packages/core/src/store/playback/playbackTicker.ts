import type { PlaylistPlayer, PlaylistPlayerState } from '../../playback/playlistPlayer';
import type { LivePlayback } from './livePlayback';

/** How often playback state is re-read. */
export const PLAYBACK_TICK_MS = 200;

export interface PlaybackTickerOptions {
  livePlayback: LivePlayback;
  playlistPlayer: Pick<PlaylistPlayer, 'checkPreload'>;
  /** Runs after each tick's publish, with the state it published (e.g. throttled position persistence). */
  onTick?: (state: PlaylistPlayerState) => void;
  intervalMs?: number;
}

/**
 * The player has no event stream for position, so this polls it: publishes
 * the fresh state, then drives the preload/crossfade scheduler (which reuses
 * this tick rather than running a second timer). Returns a stop function.
 */
export function startPlaybackTicker({ livePlayback, playlistPlayer, onTick, intervalMs = PLAYBACK_TICK_MS }: PlaybackTickerOptions): () => void {
  const interval = setInterval(() => {
    const state = livePlayback.publish();
    playlistPlayer.checkPreload();
    onTick?.(state);
  }, intervalMs);
  return () => clearInterval(interval);
}
