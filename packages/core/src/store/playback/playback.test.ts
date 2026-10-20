import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../createStore';
import type { Services } from '../services';
import { fakeLivePlayback, idlePlayerState } from '../testing';
import { LivePlayback } from './livePlayback';
import { coarsePlaybackEqual, toCoarsePlayback } from './playbackSlice';
import { isPlaybackActive, startPlaybackTicker } from './playbackTicker';

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

  const withStatus = (status: 'playing' | 'paused' | 'idle' | 'loading', pendingIncoming = null as null | { positionSeconds: number; durationSeconds: number; fadeDurationSeconds: number }) =>
    idlePlayerState({ currentFileId: 'a', track: { status, isAudible: status === 'playing', positionSeconds: 1, durationSeconds: 100, pendingIncoming } });

  function setup(initial = idlePlayerState()) {
    const fake = fakeLivePlayback(initial);
    const preload = vi.fn();
    const onTick = vi.fn();
    const stop = startPlaybackTicker({ livePlayback: fake.live, playlistPlayer: { checkPreload: preload }, onTick });
    return { ...fake, preload, onTick, stop };
  }

  it('is active only while playing, loading, or crossfading', () => {
    expect(isPlaybackActive(withStatus('playing'))).toBe(true);
    expect(isPlaybackActive(withStatus('loading'))).toBe(true);
    expect(isPlaybackActive(withStatus('paused', { positionSeconds: 0, durationSeconds: 9, fadeDurationSeconds: 1 }))).toBe(true);
    expect(isPlaybackActive(withStatus('paused'))).toBe(false);
    expect(isPlaybackActive(withStatus('idle'))).toBe(false);
  });

  it('does not run at all while idle or paused', () => {
    const { live, preload, onTick } = setup(withStatus('paused'));
    vi.advanceTimersByTime(5000);
    expect(preload).not.toHaveBeenCalled();
    expect(onTick).not.toHaveBeenCalled();
    expect(live.getSnapshot().track.status).toBe('paused');
  });

  it('starts when a published state is active, and each tick publishes, then preloads, then reports', () => {
    const order: string[] = [];
    const fake = fakeLivePlayback();
    const publish = vi.spyOn(fake.live, 'publish');
    startPlaybackTicker({
      livePlayback: fake.live,
      playlistPlayer: { checkPreload: () => void order.push('preload') },
      onTick: () => void order.push('tick'),
    });
    fake.setState(withStatus('playing'));
    fake.live.publish(); // the command's own publish starts the ticker
    publish.mockClear();
    vi.advanceTimersByTime(200);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['preload', 'tick']);
    vi.advanceTimersByTime(400);
    expect(order).toHaveLength(6);
  });

  it('stops on the first tick that finds the player inactive, and restarts on the next active publish', () => {
    const s = setup();
    s.setState(withStatus('playing'));
    s.live.publish();
    vi.advanceTimersByTime(200);
    expect(s.onTick).toHaveBeenCalledTimes(1);

    s.setState(withStatus('paused'));
    vi.advanceTimersByTime(200); // this tick sees paused, publishes it, and stops
    expect(s.onTick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(s.onTick).toHaveBeenCalledTimes(2);

    s.setState(withStatus('playing'));
    s.live.publish();
    vi.advanceTimersByTime(400);
    expect(s.onTick).toHaveBeenCalledTimes(4);
  });

  it('keeps ticking through a decode, so its asynchronous completion is noticed', () => {
    const s = setup();
    s.setState(withStatus('loading'));
    s.live.publish();
    vi.advanceTimersByTime(600);
    expect(s.onTick).toHaveBeenCalledTimes(3);
    s.setState(withStatus('idle')); // decode failed
    vi.advanceTimersByTime(200);
    vi.advanceTimersByTime(2000);
    expect(s.onTick).toHaveBeenCalledTimes(4);
    expect(s.live.getSnapshot().track.status).toBe('idle');
  });

  it('starts immediately if the player is already active when it is started', () => {
    const s = setup(withStatus('playing'));
    vi.advanceTimersByTime(200);
    expect(s.onTick).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels a running ticker and detaches from the live state', () => {
    const s = setup(withStatus('playing'));
    s.stop();
    vi.advanceTimersByTime(2000);
    s.live.publish();
    vi.advanceTimersByTime(2000);
    expect(s.onTick).not.toHaveBeenCalled();
  });
});
