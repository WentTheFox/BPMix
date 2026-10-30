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

/** How often a platform's own timer drives the ticker while the app is in the background (see BackgroundTicks). */
export const BACKGROUND_TICK_MS = 500;

/**
 * For platforms whose JS timers stop running while the app is in the background (Android): a timer that
 * doesn't, to keep playback state, preloading and everything driven by the ticker moving then.
 */
export interface BackgroundTicks {
  /** Whether JS timers can't be relied on right now. */
  isBackground(): boolean;
  /** Calls back whenever that changes; returns the unsubscribe function. */
  subscribe(callback: (background: boolean) => void): () => void;
  /** Calls `callback` about every `intervalMs` from a timer that survives the background, until the returned function is called. */
  start(intervalMs: number, callback: () => void): () => void;
}

export interface PlaybackTickerOptions {
  livePlayback: LivePlayback;
  playlistPlayer: Pick<PlaylistPlayer, 'checkPreload'>;
  /** Runs after each tick's publish, with the state it published (e.g. throttled position persistence). */
  onTick?: (state: PlaylistPlayerState) => void;
  intervalMs?: number;
  /** Drives the ticker while the app is in the background, where setInterval is paused. Omit where timers just work (web, Windows). */
  background?: BackgroundTicks;
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
export function startPlaybackTicker({ livePlayback, playlistPlayer, onTick, intervalMs = PLAYBACK_TICK_MS, background }: PlaybackTickerOptions): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopBackgroundTicks: (() => void) | null = null;

  const stopTimers = () => {
    if (interval !== null) clearInterval(interval);
    interval = null;
    stopBackgroundTicks?.();
    stopBackgroundTicks = null;
  };

  const tick = () => {
    const state = livePlayback.publish();
    playlistPlayer.checkPreload();
    onTick?.(state);
    if (!isPlaybackActive(state)) stopTimers();
  };

  // One timer at a time: setInterval in the foreground, the platform's own while backgrounded.
  const ensureRunning = (state: PlaylistPlayerState) => {
    if (!isPlaybackActive(state)) return;
    if (background?.isBackground()) {
      if (stopBackgroundTicks === null) {
        if (interval !== null) clearInterval(interval);
        interval = null;
        stopBackgroundTicks = background.start(BACKGROUND_TICK_MS, tick);
      }
    } else if (interval === null) {
      interval = setInterval(tick, intervalMs);
    }
  };

  const unsubscribe = livePlayback.subscribe(ensureRunning);
  // Changing between foreground and background swaps the timer, and catches up at once on whatever was missed.
  const unsubscribeBackground = background?.subscribe(() => {
    stopTimers();
    const state = livePlayback.getSnapshot();
    if (isPlaybackActive(state)) {
      tick();
      ensureRunning(livePlayback.getSnapshot());
    }
  });
  ensureRunning(livePlayback.getSnapshot());
  return () => {
    unsubscribe();
    unsubscribeBackground?.();
    stopTimers();
  };
}
