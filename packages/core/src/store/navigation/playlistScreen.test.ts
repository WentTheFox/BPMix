import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantedRoot } from '../../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../../library-store/types';

const mocks = vi.hoisted(() => ({
  movePlaylistTracks: vi.fn(async () => {}),
  removePlaylistTracks: vi.fn(async () => {}),
  addTracksToPlaylist: vi.fn(async () => {}),
  findUnplaylistedTracksQueued: vi.fn(async () => [] as unknown[]),
}));
vi.mock('../../library-scan/editPlaylistTracks', () => ({
  movePlaylistTracks: mocks.movePlaylistTracks,
  removePlaylistTracks: mocks.removePlaylistTracks,
}));
vi.mock('../../library-scan/addTracksToPlaylist', () => ({ addTracksToPlaylist: mocks.addTracksToPlaylist }));
vi.mock('../../library-scan/findUnplaylistedTracks', () => ({ findUnplaylistedTracksQueued: mocks.findUnplaylistedTracksQueued }));

import { createStore } from '../createStore';
import { grantedRootsLoaded } from '../library/librarySlice';
import type { Services } from '../services';
import { fakeLivePlayback } from '../testing';
import {
  addToPlaylistTrackSet,
  openPlaylistTracksMoved,
  openPlaylistTracksRemoved,
  playbackRestored,
  playingContextSetFromScreen,
  playlistScreenOpened,
  selectPlayingContext,
  selectScreen,
  unplaylistedLoaded,
  unplaylistedRequested,
  unplaylistedSettled,
} from './navigationSlice';
import {
  addPendingTrackToPlaylist,
  moveOpenPlaylistTracks,
  openPlaylist,
  removeOpenPlaylistTracks,
  showNowPlaying,
  showUnplaylisted,
} from './playlistThunks';

const root = { id: 'r1', displayName: 'Music' } as unknown as GrantedRoot;
const track = (fileId: string) => ({ fileId, rootId: 'r1', relativePath: `${fileId}.mp3` }) as unknown as TrackRecord;
const playlist = (id: string, trackFileIds: string[]): PlaylistRecord => ({ id, rootId: 'r1', fileId: id, name: id, trackFileIds });
const context = (id = 'p1', ids = ['a', 'b', 'c', 'd']) => ({ root, playlist: playlist(id, ids), tracks: ids.map(track) });

function makeStore(shuffleOrder: string[] | null = null) {
  const playlistPlayer = { getShuffleOrder: vi.fn(() => shuffleOrder) };
  const services = { fileAccess: {}, backgroundFileAccess: {}, libraryStore: {}, coverArtResizer: {}, playlistPlayer, livePlayback: fakeLivePlayback().live, now: () => 1 } as unknown as Services;
  return createStore(services);
}
const nav = (store: ReturnType<typeof makeStore>) => store.getState().navigation;
const openScreen = (store: ReturnType<typeof makeStore>) => {
  const { screen } = nav(store);
  return screen.kind === 'playlist' ? screen : null;
};

beforeEach(() => vi.clearAllMocks());

describe('open playlist screen', () => {
  it('exposes the screen with a memoized tracksById map', () => {
    const store = makeStore();
    expect(selectScreen(store.getState())).toEqual({ kind: 'library' });
    store.dispatch(playlistScreenOpened(context()));
    const screen = selectScreen(store.getState());
    expect(screen.kind === 'playlist' && screen.tracksById.get('b')).toMatchObject({ fileId: 'b' });
    expect(selectScreen(store.getState())).toBe(screen);
  });

  it('moves tracks before/after an anchor, and ignores a stale or missing target', () => {
    const store = makeStore();
    store.dispatch(playlistScreenOpened(context()));
    store.dispatch(openPlaylistTracksMoved({ playlistId: 'p1', movingFileIds: ['a'], anchorFileId: 'c', position: 'after' }));
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['b', 'c', 'a', 'd']);
    store.dispatch(openPlaylistTracksMoved({ playlistId: 'p1', movingFileIds: ['d'], anchorFileId: 'b', position: 'before' }));
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['d', 'b', 'c', 'a']);
    store.dispatch(openPlaylistTracksMoved({ playlistId: 'other', movingFileIds: ['a'], anchorFileId: 'b', position: 'before' }));
    store.dispatch(openPlaylistTracksMoved({ playlistId: 'p1', movingFileIds: ['a'], anchorFileId: 'gone', position: 'before' }));
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['d', 'b', 'c', 'a']);
  });

  it('removes tracks only from the matching open playlist', () => {
    const store = makeStore();
    store.dispatch(playlistScreenOpened(context()));
    store.dispatch(openPlaylistTracksRemoved({ playlistId: 'other', fileIds: ['a'] }));
    store.dispatch(openPlaylistTracksRemoved({ playlistId: 'p1', fileIds: ['a', 'c'] }));
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['b', 'd']);
  });

  it('records the open playlist as the playing one', () => {
    const store = makeStore();
    store.dispatch(playingContextSetFromScreen());
    expect(nav(store).playingContext).toBeNull();
    store.dispatch(playlistScreenOpened(context()));
    store.dispatch(playingContextSetFromScreen());
    expect(selectPlayingContext(store.getState())?.playlist.id).toBe('p1');
    expect(selectPlayingContext(store.getState())?.tracksById.size).toBe(4);
  });

  it('restores the last screen, Now Playing flag and playing context', () => {
    const store = makeStore();
    store.dispatch(playbackRestored({ opened: context('p2'), nowPlayingOpen: true, playing: context('p1') }));
    expect(nav(store)).toMatchObject({ nowPlayingOpen: true, playingContext: { playlist: { id: 'p1' } } });
    expect(openScreen(store)?.playlist.id).toBe('p2');

    const second = makeStore();
    second.dispatch(playbackRestored({ opened: null, nowPlayingOpen: false, playing: context('p1') }));
    expect(nav(second).screen).toEqual({ kind: 'library' });
    expect(nav(second).nowPlayingOpen).toBe(false);
  });
});

describe('unplaylisted request guard', () => {
  it('only the latest request clears "Finding…", and a stale result is ignored', () => {
    const store = makeStore();
    store.dispatch(unplaylistedRequested());
    store.dispatch(unplaylistedRequested());
    store.dispatch(unplaylistedSettled(1));
    expect(nav(store).isFindingUnplaylisted).toBe(true);
    store.dispatch(unplaylistedSettled(2));
    expect(nav(store).isFindingUnplaylisted).toBe(false);

    store.dispatch(playlistScreenOpened(context('virtual:r1:unplaylisted', [])));
    store.dispatch(unplaylistedLoaded({ playlist: playlist('someone-else', ['x']), tracks: [track('x')] }));
    expect(openScreen(store)?.tracks).toEqual([]);
  });
});

describe('playlist thunks', () => {
  it('openPlaylist opens the screen and reports it for persistence', () => {
    const store = makeStore();
    const onOpened = vi.fn();
    store.dispatch(openPlaylist(context(), { onOpened }));
    expect(onOpened).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), 'r1');
    expect(nav(store).screen.kind).toBe('playlist');
  });

  it('showNowPlaying uses the live shuffle order when shuffled, file order otherwise, and does nothing with no playing context', () => {
    const none = makeStore();
    none.dispatch(showNowPlaying());
    expect(nav(none).screen).toEqual({ kind: 'library' });

    const sequential = makeStore(null);
    sequential.dispatch(playbackRestored({ opened: null, nowPlayingOpen: false, playing: context() }));
    sequential.dispatch(showNowPlaying());
    expect(openScreen(sequential)?.playlist).toMatchObject({
      id: 'virtual:r1:now-playing',
      name: 'Now Playing',
      trackFileIds: ['a', 'b', 'c', 'd'],
    });

    const shuffled = makeStore(['d', 'a', 'c', 'b']);
    shuffled.dispatch(playbackRestored({ opened: null, nowPlayingOpen: false, playing: context() }));
    shuffled.dispatch(showNowPlaying());
    expect(openScreen(shuffled)?.playlist.trackFileIds).toEqual(['d', 'a', 'c', 'b']);
  });

  it('showUnplaylisted opens empty immediately, fills in the walk result, and is a no-op if already open or the root is unknown', async () => {
    const store = makeStore();
    store.dispatch(grantedRootsLoaded([root]));
    mocks.findUnplaylistedTracksQueued.mockResolvedValue([track('x'), track('y')]);
    const onOpened = vi.fn();
    const running = store.dispatch(showUnplaylisted('r1', { onOpened }));
    expect(nav(store).isFindingUnplaylisted).toBe(true);
    expect(openScreen(store)?.tracks).toEqual([]);
    await running;
    expect(nav(store).isFindingUnplaylisted).toBe(false);
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['x', 'y']);

    await store.dispatch(showUnplaylisted('r1', { onOpened }));
    expect(mocks.findUnplaylistedTracksQueued).toHaveBeenCalledTimes(1);

    await store.dispatch(showUnplaylisted('nope'));
    expect(mocks.findUnplaylistedTracksQueued).toHaveBeenCalledTimes(1);
  });

  it('drops a stale walk result when the user navigated on', async () => {
    const store = makeStore();
    store.dispatch(grantedRootsLoaded([root]));
    let resolveWalk: (t: unknown[]) => void = () => {};
    mocks.findUnplaylistedTracksQueued.mockReturnValue(new Promise((r) => (resolveWalk = r)));
    const running = store.dispatch(showUnplaylisted('r1'));
    store.dispatch(unplaylistedRequested()); // a newer request supersedes it
    resolveWalk([track('x')]);
    await running;
    expect(openScreen(store)?.tracks).toEqual([]);
  });

  it('move/remove write the file, patch the open screen, then rescan; failures raise a notification and leave the screen alone', async () => {
    const store = makeStore();
    const rescan = vi.fn();
    store.dispatch(playlistScreenOpened(context()));
    await store.dispatch(moveOpenPlaylistTracks(['a'], 'c', 'after', { rescan }));
    expect(mocks.movePlaylistTracks).toHaveBeenCalledTimes(1);
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['b', 'c', 'a', 'd']);
    expect(rescan).toHaveBeenCalledWith('r1');

    await store.dispatch(removeOpenPlaylistTracks(['b'], { rescan }));
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['c', 'a', 'd']);

    mocks.removePlaylistTracks.mockRejectedValueOnce(new Error('disk full'));
    await store.dispatch(removeOpenPlaylistTracks(['c'], { rescan }));
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['c', 'a', 'd']);
    expect(store.getState().notifications.items[0]).toMatchObject({ title: 'Couldn\'t remove tracks from "p1"', detail: 'disk full' });
    expect(rescan).toHaveBeenCalledTimes(2);
  });

  it('moving/removing with no playlist open does nothing', async () => {
    const store = makeStore();
    await store.dispatch(moveOpenPlaylistTracks(['a'], 'c', 'after', { rescan: vi.fn() }));
    expect(mocks.movePlaylistTracks).not.toHaveBeenCalled();
  });

  it('adds the pending track to a playlist, drops it from the open view and clears the pending track', async () => {
    const store = makeStore();
    const rescan = vi.fn();
    store.dispatch(playlistScreenOpened(context('virtual:r1:unplaylisted', ['a', 'b'])));
    store.dispatch(addToPlaylistTrackSet(track('a')));
    await store.dispatch(addPendingTrackToPlaylist(playlist('p9', []), 'end', { rescan }));
    expect(mocks.addTracksToPlaylist).toHaveBeenCalledWith(expect.anything(), 'r1', expect.objectContaining({ id: 'p9' }), [expect.objectContaining({ fileId: 'a' })], 'end');
    expect(openScreen(store)?.playlist.trackFileIds).toEqual(['b']);
    expect(nav(store).addToPlaylistTrack).toBeNull();
    expect(rescan).toHaveBeenCalledWith('r1');
  });

  it('keeps the pending track and reports an error if adding fails', async () => {
    const store = makeStore();
    store.dispatch(playlistScreenOpened(context('virtual:r1:unplaylisted', ['a'])));
    store.dispatch(addToPlaylistTrackSet(track('a')));
    mocks.addTracksToPlaylist.mockRejectedValueOnce(new Error('nope'));
    await store.dispatch(addPendingTrackToPlaylist(playlist('p9', []), 'start', { rescan: vi.fn() }));
    expect(nav(store).addToPlaylistTrack).toMatchObject({ fileId: 'a' });
    expect(store.getState().notifications.items[0]!.detail).toBe('nope');
  });
});
