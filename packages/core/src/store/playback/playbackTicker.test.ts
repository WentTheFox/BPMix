import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistPlayerState } from '../../playback/playlistPlayer';
import { BACKGROUND_TICK_MS, PLAYBACK_TICK_MS, startPlaybackTicker, type BackgroundTicks } from './playbackTicker';

const state = (status: 'playing' | 'paused'): PlaylistPlayerState => ({ track: { status, pendingIncoming: null } }) as unknown as PlaylistPlayerState;

/** A LivePlayback stand-in whose state the test sets. */
function fakeLive(initial: PlaylistPlayerState) {
  let current = initial;
  const listeners = new Set<(s: PlaylistPlayerState) => void>();
  return {
    publish: vi.fn(() => current),
    getSnapshot: () => current,
    subscribe: (l: (s: PlaylistPlayerState) => void) => (listeners.add(l), () => listeners.delete(l)),
    set(next: PlaylistPlayerState) {
      current = next;
      for (const l of listeners) l(next);
    },
  };
}

/** A background timer the test drives by hand. */
function fakeBackground() {
  let background = false;
  const subscribers = new Set<(background: boolean) => void>();
  const started: { intervalMs: number; callback: () => void; stopped: boolean }[] = [];
  const api: BackgroundTicks = {
    isBackground: () => background,
    subscribe: (cb) => (subscribers.add(cb), () => subscribers.delete(cb)),
    start: (intervalMs, callback) => {
      const entry = { intervalMs, callback, stopped: false };
      started.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
  };
  return {
    api,
    started,
    setBackground(next: boolean) {
      background = next;
      for (const cb of subscribers) cb(next);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startPlaybackTicker', () => {
  it('ticks on setInterval while playing, and stops once nothing is active', () => {
    const live = fakeLive(state('playing'));
    const onTick = vi.fn();
    const stop = startPlaybackTicker({ livePlayback: live as never, playlistPlayer: { checkPreload: vi.fn() }, onTick });
    vi.advanceTimersByTime(PLAYBACK_TICK_MS * 3);
    expect(onTick).toHaveBeenCalledTimes(3);
    live.set(state('paused')); // the next tick finds it inactive and stops
    vi.advanceTimersByTime(PLAYBACK_TICK_MS * 5);
    expect(onTick.mock.calls.length).toBeLessThanOrEqual(4);
    stop();
  });

  it('hands over to the native timer in the background, and back again, without ever running both', () => {
    const live = fakeLive(state('playing'));
    const bg = fakeBackground();
    const checkPreload = vi.fn();
    const onTick = vi.fn();
    const stop = startPlaybackTicker({ livePlayback: live as never, playlistPlayer: { checkPreload }, onTick, background: bg.api });
    vi.advanceTimersByTime(PLAYBACK_TICK_MS * 2);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(bg.started).toHaveLength(0);

    bg.setBackground(true); // catches up at once (one tick), then the native timer drives
    expect(onTick).toHaveBeenCalledTimes(3);
    expect(bg.started).toHaveLength(1);
    expect(bg.started[0]!.intervalMs).toBe(BACKGROUND_TICK_MS);
    vi.advanceTimersByTime(PLAYBACK_TICK_MS * 10); // JS timers don't run in the background: none of these may tick
    expect(onTick).toHaveBeenCalledTimes(3);
    bg.started[0]!.callback();
    bg.started[0]!.callback();
    expect(onTick).toHaveBeenCalledTimes(5);
    expect(checkPreload).toHaveBeenCalledTimes(5); // the preload/crossfade scheduler rides on the same ticks

    bg.setBackground(false);
    expect(bg.started[0]!.stopped).toBe(true);
    expect(onTick).toHaveBeenCalledTimes(6);
    vi.advanceTimersByTime(PLAYBACK_TICK_MS * 2);
    expect(onTick).toHaveBeenCalledTimes(8);
    stop();
  });

  it('starts on the native timer when playback begins while already in the background, and releases it when done', () => {
    const live = fakeLive(state('paused'));
    const bg = fakeBackground();
    bg.setBackground(true);
    const stop = startPlaybackTicker({ livePlayback: live as never, playlistPlayer: { checkPreload: vi.fn() }, onTick: vi.fn(), background: bg.api });
    expect(bg.started).toHaveLength(0);
    live.set(state('playing'));
    expect(bg.started).toHaveLength(1);
    live.set(state('paused'));
    bg.started[0]!.callback(); // the tick that finds nothing active stops the native timer
    expect(bg.started[0]!.stopped).toBe(true);
    stop();
  });
});
