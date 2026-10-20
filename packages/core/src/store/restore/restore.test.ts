import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileAccessPermissionPendingError } from '../../file-access/types';
import type { GrantedRoot } from '../../file-access/types';
import type { PlaybackState, PlaylistRecord, TrackRecord } from '../../library-store/types';

const mocks = vi.hoisted(() => ({
  loadRootLibrary: vi.fn(),
  ensureLyricsAssignment: vi.fn(async () => {}),
  refreshLibrary: vi.fn(),
}));
vi.mock('../../library-scan/loadRootLibrary', () => ({ loadRootLibrary: mocks.loadRootLibrary }));
vi.mock('../../lyrics/ensureLyricsAssignment', () => ({ ensureLyricsAssignment: mocks.ensureLyricsAssignment }));
vi.mock('../library/refreshLibrary', () => ({ refreshLibrary: mocks.refreshLibrary }));

import { createStore } from '../createStore';
import { DEFAULT_PLAYBACK_STATE } from '../persistence/persistenceSlice';
import type { Services } from '../services';
import { fakeLivePlayback } from '../testing';
import { restorePlayback } from './restorePlayback';
import { userTookOver } from './restoreSlice';

const root = (id: string) => ({ id, displayName: id }) as unknown as GrantedRoot;
const track = (fileId: string) => ({ fileId, rootId: 'r1', relativePath: `Album/${fileId}.mp3` }) as unknown as TrackRecord;
const playlist = (id: string, trackFileIds: string[]): PlaylistRecord => ({ id, rootId: 'r1', fileId: id, name: id, trackFileIds });
const stored = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  ...DEFAULT_PLAYBACK_STATE,
  playlistId: 'p1',
  currentTrackFileId: 'b',
  rootId: 'r1',
  openedPlaylistId: 'p1',
  openedRootId: 'r1',
  positionSeconds: 42,
  loopMode: 'all',
  shuffleEnabled: true,
  shuffleOrder: ['b', 'a'],
  volume: 0.5,
  nowPlayingOpen: true,
  ...over,
});

interface Opts {
  stored?: PlaybackState | null;
  roots?: GrantedRoot[];
  scopes?: unknown[];
  isCancelled?: () => boolean;
  onListRoots?: () => void;
  loadPromise?: Promise<unknown>;
}

function setup(opts: Opts = {}) {
  const calls: string[] = [];
  const library = { playlists: [playlist('p1', ['a', 'b'])], tracksById: new Map([track('a'), track('b')].map((t) => [t.fileId, t])) };
  mocks.loadRootLibrary.mockResolvedValue(library);
  mocks.refreshLibrary.mockImplementation(() => () => {
    calls.push('refresh');
    return Promise.resolve([]);
  });
  const { live } = fakeLivePlayback();
  const playlistPlayer = {
    setVolume: vi.fn(() => void calls.push('setVolume')),
    setShuffle: vi.fn(() => void calls.push('setShuffle')),
    setLoopMode: vi.fn(() => void calls.push('setLoopMode')),
    loadPlaylist: vi.fn((..._args: unknown[]) => {
      calls.push('loadPlaylist');
      return opts.loadPromise ?? Promise.resolve();
    }),
    seek: vi.fn(),
  };
  const fileAccess = {
    listGrantedRoots: vi.fn(async () => {
      opts.onListRoots?.();
      return opts.roots ?? [root('r1')];
    }),
  };
  const libraryStore = {
    listPlaylists: vi.fn(async () => [playlist('p1', [])]),
    getLyricsScopes: vi.fn(async () => opts.scopes ?? []),
  };
  const services = {
    fileAccess,
    backgroundFileAccess: fileAccess,
    libraryStore,
    playlistPlayer,
    livePlayback: live,
    initialPlaybackState: Promise.resolve(opts.stored === undefined ? stored() : opts.stored),
  } as unknown as Services;
  const store = createStore(services);
  const run = () => store.dispatch(restorePlayback({ isCancelled: opts.isCancelled ?? (() => false) }));
  return { store, run, calls, playlistPlayer, fileAccess, live, libraryStore };
}

beforeEach(() => vi.clearAllMocks());

describe('restorePlayback', () => {
  it('restores the playlist paused: sets modes, loads, shows the screen, seeks after the decode, and finishes', async () => {
    const { store, run, playlistPlayer, live } = setup();
    const publish = vi.spyOn(live, 'publish');
    await run();
    await Promise.resolve();
    await Promise.resolve();

    expect(playlistPlayer.setVolume).toHaveBeenCalledWith(0.5);
    expect(playlistPlayer.setShuffle).toHaveBeenCalledWith(true);
    expect(playlistPlayer.setLoopMode).toHaveBeenCalledWith('all');
    expect(playlistPlayer.loadPlaylist).toHaveBeenCalledWith(['a', 'b'], 'b', { shuffleOrder: ['b', 'a'], playlistId: 'p1' });
    const nav = store.getState().navigation;
    expect(nav.screen.kind === 'playlist' && nav.screen.playlist.id).toBe('p1');
    expect(nav.nowPlayingOpen).toBe(true);
    expect(nav.playingContext?.playlist.id).toBe('p1');
    expect(playlistPlayer.seek).toHaveBeenCalledWith(42);
    expect(publish).toHaveBeenCalled();
    expect(store.getState().restore.isRestoring).toBe(false);
    expect(store.getState().persistence.ready).toBe(true);
    expect(store.getState().restore.completedSteps).toEqual(['listingFolders', 'restoringPlayback', 'scanningLibrary']);
    expect(store.getState().restore.currentStep).toBe('loadingPlaylist');
  });

  it('makes the playlist the playing context BEFORE loading it, since the player resolves tracks through it from the first decode', async () => {
    const { store, run, playlistPlayer } = setup();
    let contextAtLoad: string | undefined;
    playlistPlayer.loadPlaylist.mockImplementation(() => {
      contextAtLoad = store.getState().navigation.playingContext?.playlist.id;
      return Promise.resolve();
    });
    await run();
    expect(contextAtLoad).toBe('p1');
  });

  it('does not wait for the decode: resolves (and refreshes in the background) while loadPlaylist is still pending', async () => {
    const { store, run, calls, playlistPlayer } = setup({ loadPromise: new Promise(() => {}) });
    await run();
    expect(store.getState().restore.isRestoring).toBe(false);
    expect(calls).toContain('refresh');
    expect(playlistPlayer.seek).not.toHaveBeenCalled();
  });

  it('with nothing stored: becomes ready, loads nothing, still refreshes and finishes', async () => {
    const { store, run, playlistPlayer, calls } = setup({ stored: null });
    await run();
    expect(store.getState().persistence.ready).toBe(true);
    expect(playlistPlayer.loadPlaylist).not.toHaveBeenCalled();
    expect(playlistPlayer.setVolume).not.toHaveBeenCalled();
    expect(calls).toEqual(['refresh']);
    expect(store.getState().restore.isRestoring).toBe(false);
  });

  it('does not seek for a saved position of 0', async () => {
    const { run, playlistPlayer } = setup({ stored: stored({ positionSeconds: 0 }) });
    await run();
    await Promise.resolve();
    expect(playlistPlayer.seek).not.toHaveBeenCalled();
  });

  it('does not apply itself if the user took over while it was in flight, but still refreshes', async () => {
    const ctx: { store?: ReturnType<typeof setup>['store'] } = {};
    const s = setup({ onListRoots: () => ctx.store!.dispatch(userTookOver()) });
    ctx.store = s.store;
    await s.run();
    expect(s.playlistPlayer.loadPlaylist).not.toHaveBeenCalled();
    expect(s.store.getState().navigation.playingContext).toBeNull();
    expect(s.calls).toContain('refresh');
    expect(s.store.getState().restore.isRestoring).toBe(false);
  });

  it('does not apply itself if the user took over during the lyrics lookup (the gap right before touching the player)', async () => {
    const s = setup({ scopes: [{ rootId: 'r1', relativePath: '' }] });
    mocks.ensureLyricsAssignment.mockImplementationOnce(async () => void s.store.dispatch(userTookOver()));
    await s.run();
    expect(mocks.ensureLyricsAssignment).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'b', 'b.mp3');
    expect(s.playlistPlayer.loadPlaylist).not.toHaveBeenCalled();
  });

  it('does not seek or publish over a user who took over during the decode', async () => {
    let finishDecode: () => void = () => {};
    const s = setup({ loadPromise: new Promise<void>((r) => (finishDecode = r)) });
    const publish = vi.spyOn(s.live, 'publish');
    await s.run();
    s.store.dispatch(userTookOver());
    finishDecode();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.playlistPlayer.seek).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('applies nothing and leaves isRestoring alone once cancelled', async () => {
    let cancelled = false;
    const s = setup({ isCancelled: () => cancelled, onListRoots: () => void (cancelled = true) });
    await s.run();
    expect(s.playlistPlayer.loadPlaylist).not.toHaveBeenCalled();
    expect(s.calls).not.toContain('refresh');
    expect(s.store.getState().restore.isRestoring).toBe(true);
  });

  it('finds the root by searching cached playlists when the stored root is gone', async () => {
    const s = setup({ stored: stored({ rootId: 'removed' }), roots: [root('r0'), root('r1')] });
    s.libraryStore.listPlaylists.mockImplementation(async () => [playlist('p1', [])]);
    await s.run();
    expect(s.playlistPlayer.loadPlaylist).toHaveBeenCalled();
    expect(mocks.loadRootLibrary).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ id: 'r0' }));
  });

  it('resumes nothing if no root holds the playlist, but still refreshes', async () => {
    const s = setup({ roots: [] });
    await s.run();
    expect(s.playlistPlayer.loadPlaylist).not.toHaveBeenCalled();
    expect(s.calls).toContain('refresh');
  });

  it('resumes nothing for a root whose grant lapsed (permission pending), and does not report it as an error', async () => {
    const s = setup();
    mocks.loadRootLibrary.mockRejectedValue(new FileAccessPermissionPendingError('r1'));
    await s.run();
    expect(s.playlistPlayer.loadPlaylist).not.toHaveBeenCalled();
    expect(s.store.getState().library.error).toBeNull();
    expect(s.calls).toContain('refresh');
  });

  it('resumes nothing if the playlist or track is gone', async () => {
    const s = setup({ stored: stored({ currentTrackFileId: 'gone' }) });
    await s.run();
    expect(s.playlistPlayer.loadPlaylist).not.toHaveBeenCalled();
  });

  it('opens a different playlist than the playing one when that is what was open', async () => {
    const s = setup({ stored: stored({ openedPlaylistId: 'p2', openedRootId: 'r2' }), roots: [root('r1'), root('r2')] });
    mocks.loadRootLibrary
      .mockResolvedValueOnce({ playlists: [playlist('p1', ['a', 'b'])], tracksById: new Map([track('a'), track('b')].map((t) => [t.fileId, t])) })
      .mockResolvedValueOnce({ playlists: [playlist('p2', ['z'])], tracksById: new Map([['z', track('z')]]) });
    await s.run();
    const { screen, playingContext } = s.store.getState().navigation;
    expect(screen.kind === 'playlist' && screen.playlist.id).toBe('p2');
    expect(playingContext?.playlist.id).toBe('p1');
  });

  it('shows the Library when none was open', async () => {
    const s = setup({ stored: stored({ openedPlaylistId: null }) });
    await s.run();
    expect(s.store.getState().navigation.screen).toEqual({ kind: 'library' });
    expect(s.store.getState().navigation.playingContext?.playlist.id).toBe('p1');
  });

  it('falls back to the playing playlist for state saved before openedPlaylistId existed', async () => {
    const legacy = stored();
    delete (legacy as Partial<PlaybackState>).openedPlaylistId;
    delete (legacy as Partial<PlaybackState>).nowPlayingOpen;
    const s = setup({ stored: legacy });
    await s.run();
    const { screen, nowPlayingOpen } = s.store.getState().navigation;
    expect(screen.kind === 'playlist' && screen.playlist.id).toBe('p1');
    expect(nowPlayingOpen).toBe(false);
  });

  it('with lyrics scopes configured, resolves the current track\'s lyrics assignment and shows that step', async () => {
    const s = setup({ scopes: [{ rootId: 'r1', relativePath: '' }] });
    await s.run();
    expect(s.store.getState().restore.hasLyricsScopes).toBe(true);
    expect(s.store.getState().restore.completedSteps).toContain('scanningLyrics');
    expect(s.store.getState().library.lyricsScopes).toHaveLength(1);
  });

  it('a pending-permission lyrics lookup does not abort the restore', async () => {
    const s = setup({ scopes: [{ rootId: 'r1', relativePath: '' }] });
    mocks.ensureLyricsAssignment.mockRejectedValueOnce(new FileAccessPermissionPendingError('r1'));
    await s.run();
    expect(s.playlistPlayer.loadPlaylist).toHaveBeenCalled();
  });

  it('any other failure is reported to the error banner, does not refresh, and still finishes the restore', async () => {
    const s = setup();
    mocks.loadRootLibrary.mockRejectedValue(new Error('disk on fire'));
    await s.run();
    expect(s.store.getState().library.error).toBe('disk on fire');
    expect(s.store.getState().restore.isRestoring).toBe(false);
  });

  it('reports a failed decode to the error banner without failing the restore', async () => {
    const s = setup({ loadPromise: Promise.reject(new Error('bad codec')) });
    await s.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.store.getState().library.error).toBe('bad codec');
    expect(s.store.getState().restore.isRestoring).toBe(false);
  });
});
