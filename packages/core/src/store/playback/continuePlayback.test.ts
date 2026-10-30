import { describe, expect, it, vi } from 'vitest';
import type { GrantedRoot } from '../../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../../library-store/types';
import type { RemotePlayback } from '../../server-mode/devicePlayback';
import { MemoryStore } from '../../server-mode/testing';
import { createStore } from '../createStore';
import type { Services } from '../services';
import { fakeLivePlayback } from '../testing';
import { continuePlayback } from './continuePlayback';

const root = { id: 'Music', displayName: 'Music', kind: 'library', removable: false } as GrantedRoot;
const track = (fileId: string) => ({ fileId, rootId: 'Music', relativePath: `${fileId}.mp3`, sizeBytes: 1, lastModifiedMs: 1 }) as TrackRecord;
const playlist = (id: string, trackFileIds: string[]): PlaylistRecord => ({ id, rootId: 'Music', fileId: id, name: id, trackFileIds });
const remote = (over: Partial<RemotePlayback> = {}): RemotePlayback => ({
  deviceId: 'phone', deviceName: 'Pixel 8', updatedAtMs: 1, playlistId: 'user:mine', rootId: 'Music', currentTrackFileId: 'b', positionSeconds: 42, loopMode: 'all', shuffleEnabled: true, shuffleOrder: null, playing: true, ...over,
});

async function setup() {
  const libraryStore = new MemoryStore();
  await libraryStore.upsertPlaylist(playlist('user:mine', ['a', 'b', 'c']));
  for (const id of ['a', 'b', 'c']) await libraryStore.upsertTrack(track(id));
  const calls: string[] = [];
  const playlistPlayer = {
    setShuffle: vi.fn((on: boolean) => calls.push(`shuffle:${on}`)),
    setLoopMode: vi.fn((mode: string) => calls.push(`loop:${mode}`)),
    setPlaylist: vi.fn(async (ids: string[], start: string, options?: { shuffleOrder?: string[] }) => void calls.push(`play:${ids.join(',')}@${start}${options?.shuffleOrder ? `/order:${options.shuffleOrder.join('')}` : ''}`)),
    seek: vi.fn((s: number) => calls.push(`seek:${s}`)),
    getShuffleOrder: () => ['c', 'b', 'a'],
    getState: () => ({}),
  };
  const services = {
    fileAccess: { listGrantedRoots: async () => [root] },
    libraryStore,
    playlistPlayer,
    livePlayback: fakeLivePlayback().live,
    now: () => 1,
  } as unknown as Services;
  return { store: createStore(services), calls, playlistPlayer };
}

describe('continuePlayback', () => {
  it('plays the other device\'s track and position here, with its loop and shuffle settings', async () => {
    const { store, calls } = await setup();
    expect(await store.dispatch(continuePlayback(remote()))).toBe(true);
    // Settings first, then the track, then the position - all after the playing context is set.
    expect(calls).toEqual(['shuffle:true', 'loop:all', 'play:a,b,c@b', 'seek:42']);
    expect(store.getState().navigation.playingContext?.playlist.id).toBe('user:mine');
  });

  it('keeps the other device\'s shuffle order', async () => {
    const { store, calls } = await setup();
    await store.dispatch(continuePlayback(remote({ shuffleOrder: ['c', 'b', 'a'] })));
    expect(calls).toContain('play:a,b,c@b/order:cba');
  });

  it('does not seek for a track that was only just started', async () => {
    const { store, calls } = await setup();
    await store.dispatch(continuePlayback(remote({ positionSeconds: 0.5 })));
    expect(calls.some((c) => c.startsWith('seek'))).toBe(false);
  });

  it('touches nothing when the playlist or track is not in this library', async () => {
    const { store, playlistPlayer } = await setup();
    expect(await store.dispatch(continuePlayback(remote({ playlistId: 'user:gone' })))).toBe(false);
    expect(await store.dispatch(continuePlayback(remote({ currentTrackFileId: 'zzz' })))).toBe(false);
    expect(playlistPlayer.setPlaylist).not.toHaveBeenCalled();
    expect(playlistPlayer.setShuffle).not.toHaveBeenCalled();
  });
});
