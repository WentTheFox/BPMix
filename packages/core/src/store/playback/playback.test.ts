import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../createStore';
import type { Services } from '../services';
import { fakeLivePlayback, idlePlayerState } from '../testing';
import { LivePlayback } from './livePlayback';
import { coarsePlaybackEqual, toCoarsePlayback } from './playbackSlice';
import { startPlaybackTicker } from './playbackTicker';

const playing = (positionSeconds: number, over = {}) =>
  idlePlayerState({
    currentFileId: 'a',
    position: 0,
    totalTracks: 3,
    track: { status: 'playing', isAudible: true, positionSeconds, durationSeconds: 200, pendingIncoming: null },
    ...over,
  });

function setup() {
  const { live, setState } = fakeLivePlayback();
  const store = createStore({ livePlayback: live } as unknown as Services);
  return { live, setState, store };
}

describe('LivePlayback', () => {
  it('serves a stable snapshot until published, then notifies subscribers', () => {
    const state = { value: idlePlayerState() };
    const live = new LivePlayback({ getState: () => state.value });
    const listener = vi.fn();
    const stop = live.subscribe(listener);
    const first = live.getSnapshot();
    expect(live.getSnapshot()).toBe(first);

    state.value = playing(5);
    const published = live.publish();
    expect(live.getSnapshot()).toBe(published);
    expect(listener).toHaveBeenCalledWith(published);

    stop();
    live.publish();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('publishes a state the caller already has instead of re-reading the player', () => {
    const live = new LivePlayback({ getState: () => idlePlayerState() });
    const given = playing(9);
    expect(live.publish(given)).toBe(given);
    expect(live.getSnapshot()).toBe(given);
  });
});

describe('playback mirror', () => {
  it('mirrors coarse changes into the store', () => {
    const { live, store } = setup();
    live.publish(playing(1));
    expect(store.getState().playback.coarse).toMatchObject({ currentFileId: 'a', status: 'playing', isAudible: true, durationSeconds: 200 });
  });

  it('does not dispatch for position-only ticks', () => {
    const { live, store } = setup();
    live.publish(playing(1));
    const before = store.getState().playback;
    const dispatch = vi.spyOn(store, 'dispatch');
    for (let t = 2; t < 50; t++) live.publish(playing(t));
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getState().playback).toBe(before);
  });

  it('dispatches when a coarse field changes, including a crossfade starting', () => {
    const { live, store } = setup();
    live.publish(playing(1));
    live.publish(playing(2, { shuffleEnabled: true }));
    expect(store.getState().playback.coarse.shuffleEnabled).toBe(true);
    live.publish(playing(3, { shuffleEnabled: true, pendingCrossfadeFileIds: { outgoing: 'a', incoming: 'b' } }));
    expect(store.getState().playback.coarse.pendingCrossfadeFileIds).toEqual({ outgoing: 'a', incoming: 'b' });
  });

  it('latches hasStartedPlayback only once something actually plays', () => {
    const { live, store } = setup();
    live.publish(idlePlayerState({ currentFileId: 'a', position: 0, totalTracks: 3 }));
    expect(store.getState().playback.hasStartedPlayback).toBe(false);
    live.publish(playing(1));
    live.publish(idlePlayerState({ currentFileId: 'a', position: 0, totalTracks: 3 }));
    expect(store.getState().playback.hasStartedPlayback).toBe(true);
  });

  it('compares pending crossfades by their ids', () => {
    const a = toCoarsePlayback(playing(1, { pendingCrossfadeFileIds: { outgoing: 'a', incoming: 'b' } }));
    const same = toCoarsePlayback(playing(9, { pendingCrossfadeFileIds: { outgoing: 'a', incoming: 'b' } }));
    const different = toCoarsePlayback(playing(1, { pendingCrossfadeFileIds: { outgoing: 'a', incoming: 'c' } }));
    expect(coarsePlaybackEqual(a, same)).toBe(true);
    expect(coarsePlaybackEqual(a, different)).toBe(false);
  });
});

describe('startPlaybackTicker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('publishes, then drives the preload scheduler, then reports the tick, every interval', () => {
    const order: string[] = [];
    const { live } = setup();
    const publish = vi.spyOn(live, 'publish').mockImplementation(() => {
      order.push('publish');
      return idlePlayerState();
    });
    const stop = startPlaybackTicker({
      livePlayback: live,
      playlistPlayer: { checkPreload: () => void order.push('preload') },
      onTick: () => void order.push('tick'),
    });
    vi.advanceTimersByTime(200);
    expect(order).toEqual(['publish', 'preload', 'tick']);
    vi.advanceTimersByTime(400);
    expect(publish).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(3);
  });
});
