import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackState } from '../../library-store/types';
import { createStore } from '../createStore';
import type { Services } from '../services';
import { fakeLivePlayback, idlePlayerState } from '../testing';
import { DEFAULT_PLAYBACK_STATE, playbackPatched, playbackStateRead } from './persistenceSlice';
import { persistPositionIfDue, playerAdvanced, POSITION_PERSIST_INTERVAL_MS } from './persistenceThunks';

let clock = 1_000_000;
function setup() {
  const putPlaybackState = vi.fn(async (_state: PlaybackState) => {});
  const playlistPlayer = { getShuffleOrder: vi.fn(() => ['x', 'y']) };
  const { live } = fakeLivePlayback();
  const store = createStore({ libraryStore: { putPlaybackState }, playlistPlayer, livePlayback: live, now: () => clock } as unknown as Services);
  return { store, putPlaybackState, live, playlistPlayer };
}
const playing = (positionSeconds: number, status: 'playing' | 'paused' | 'idle' = 'playing') =>
  idlePlayerState({ currentFileId: 'a', track: { status, isAudible: status === 'playing', positionSeconds, durationSeconds: 200, pendingIncoming: null } });

beforeEach(() => {
  clock = 1_000_000;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('playback persistence', () => {
  it('ignores patches until the initial read, so the placeholder default can never overwrite saved state', async () => {
    const { store, putPlaybackState } = setup();
    store.dispatch(playbackPatched({ patch: { nowPlayingOpen: true } }));
    await vi.runAllTimersAsync();
    expect(store.getState().persistence.state).toEqual(DEFAULT_PLAYBACK_STATE);
    expect(putPlaybackState).not.toHaveBeenCalled();
  });

  it('adopts what was stored, then merges patches onto it and writes the whole state', async () => {
    const { store, putPlaybackState } = setup();
    const saved = { ...DEFAULT_PLAYBACK_STATE, playlistId: 'p1', volume: 0.6 };
    store.dispatch(playbackStateRead(saved));
    store.dispatch(playbackPatched({ patch: { positionSeconds: 42 } }));
    await vi.runAllTimersAsync();
    expect(putPlaybackState).toHaveBeenCalledWith({ ...saved, positionSeconds: 42 });
  });

  it('with nothing stored, becomes ready on the default', async () => {
    const { store, putPlaybackState } = setup();
    store.dispatch(playbackStateRead(null));
    store.dispatch(playbackPatched({ patch: { loopMode: 'all' } }));
    await vi.runAllTimersAsync();
    expect(putPlaybackState).toHaveBeenCalledWith({ ...DEFAULT_PLAYBACK_STATE, loopMode: 'all' });
  });

  it('debounces only the write: the state updates at once and a burst coalesces into one write', async () => {
    const { store, putPlaybackState } = setup();
    store.dispatch(playbackStateRead(null));
    store.dispatch(playbackPatched({ patch: { volume: 0.1 }, debounceMs: 400 }));
    store.dispatch(playbackPatched({ patch: { volume: 0.2 }, debounceMs: 400 }));
    store.dispatch(playbackPatched({ patch: { volume: 0.3 }, debounceMs: 400 }));
    expect(store.getState().persistence.state.volume).toBe(0.3);
    expect(putPlaybackState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(putPlaybackState).toHaveBeenCalledTimes(1);
    expect(putPlaybackState).toHaveBeenCalledWith(expect.objectContaining({ volume: 0.3 }));
  });

  it('a later immediate patch supersedes a pending debounced write and carries the debounced change with it', async () => {
    const { store, putPlaybackState } = setup();
    store.dispatch(playbackStateRead(null));
    store.dispatch(playbackPatched({ patch: { volume: 0.9 }, debounceMs: 400 }));
    store.dispatch(playbackPatched({ patch: { positionSeconds: 7 } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(putPlaybackState).toHaveBeenCalledTimes(1);
    expect(putPlaybackState).toHaveBeenCalledWith(expect.objectContaining({ volume: 0.9, positionSeconds: 7 }));
  });
});

describe('persistPositionIfDue', () => {
  it('persists the first tick, then at most once per interval', async () => {
    const { store, putPlaybackState } = setup();
    store.dispatch(playbackStateRead(null));
    store.dispatch(persistPositionIfDue(playing(10)));
    await vi.runAllTimersAsync();
    expect(putPlaybackState).toHaveBeenCalledTimes(1);

    clock += POSITION_PERSIST_INTERVAL_MS - 1;
    store.dispatch(persistPositionIfDue(playing(14)));
    await vi.runAllTimersAsync();
    expect(putPlaybackState).toHaveBeenCalledTimes(1);

    clock += 1;
    store.dispatch(persistPositionIfDue(playing(15)));
    await vi.runAllTimersAsync();
    expect(putPlaybackState).toHaveBeenCalledTimes(2);
    expect(putPlaybackState).toHaveBeenLastCalledWith(expect.objectContaining({ positionSeconds: 15 }));
  });

  it('persists while paused, but not when idle/loading or with nothing loaded', async () => {
    const { store, putPlaybackState } = setup();
    store.dispatch(playbackStateRead(null));
    store.dispatch(persistPositionIfDue(playing(5, 'idle')));
    store.dispatch(persistPositionIfDue(idlePlayerState({ track: { ...playing(5).track, status: 'playing' } })));
    await vi.runAllTimersAsync();
    expect(putPlaybackState).not.toHaveBeenCalled();
    store.dispatch(persistPositionIfDue(playing(5, 'paused')));
    await vi.runAllTimersAsync();
    expect(putPlaybackState).toHaveBeenCalledTimes(1);
  });
});

describe('playerAdvanced', () => {
  it('refreshes the live state immediately and persists the new track, position and shuffle order', async () => {
    const { store, putPlaybackState, live } = setup();
    store.dispatch(playbackStateRead(null));
    const publish = vi.spyOn(live, 'publish').mockReturnValue(playing(3));
    store.dispatch(playerAdvanced());
    await vi.runAllTimersAsync();
    expect(publish).toHaveBeenCalled();
    expect(putPlaybackState).toHaveBeenCalledWith(expect.objectContaining({ currentTrackFileId: 'a', positionSeconds: 3, shuffleOrder: ['x', 'y'] }));
  });

  it('refreshes but persists nothing when no track is current', async () => {
    const { store, putPlaybackState, live } = setup();
    store.dispatch(playbackStateRead(null));
    vi.spyOn(live, 'publish').mockReturnValue(idlePlayerState());
    store.dispatch(playerAdvanced());
    await vi.runAllTimersAsync();
    expect(putPlaybackState).not.toHaveBeenCalled();
  });
});
