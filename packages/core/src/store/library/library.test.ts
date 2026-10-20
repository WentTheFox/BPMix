import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantedRoot } from '../../file-access/types';
import { FileAccessPermissionPendingError } from '../../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../../library-store/types';

const mocks = vi.hoisted(() => ({
  scanRootCoordinated: vi.fn(async () => ({})),
  matchLibraryLyricsQueued: vi.fn(async () => {}),
  scanLibraryMetadataQueued: vi.fn(async () => {}),
  pruneOrphanedRootData: vi.fn(async () => [] as string[]),
}));
vi.mock('../../library-scan/scanCoordinator', () => ({ scanRootCoordinated: mocks.scanRootCoordinated }));
vi.mock('../../library-scan/pruneOrphanedRootData', () => ({ pruneOrphanedRootData: mocks.pruneOrphanedRootData }));
vi.mock('../../metadata/scanLibraryMetadata', () => ({ scanLibraryMetadataQueued: mocks.scanLibraryMetadataQueued }));
vi.mock('../../lyrics/matchLibraryLyrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lyrics/matchLibraryLyrics')>()),
  matchLibraryLyricsQueued: mocks.matchLibraryLyricsQueued,
}));

import { createStore } from '../createStore';
import type { Services } from '../services';
import { fakeLivePlayback } from '../testing';
import {
  fileFoundReported,
  fileMissingReported,
  libraryErrorSet,
  matchedLyricsCountDecremented,
  matchedLyricsCountSet,
  selectMissingFileIds,
  selectRootsWithLibrary,
} from './librarySlice';
import { playingContextSet } from '../navigation/navigationSlice';
import { refreshLibrary } from './refreshLibrary';

const track = (fileId: string, over: Partial<TrackRecord> = {}) => ({ fileId, rootId: 'r1', relativePath: `${fileId}.mp3`, ...over }) as unknown as TrackRecord;
const playlist = (id: string, trackFileIds: string[]) => ({ id, rootId: 'r1', fileId: id, name: id, trackFileIds }) as unknown as PlaylistRecord;
const root = (id: string, kind?: 'library' | 'lyrics') => ({ id, displayName: id, kind }) as unknown as GrantedRoot;

interface Setup {
  roots?: GrantedRoot[];
  data?: Record<string, { playlists: PlaylistRecord[]; tracks: TrackRecord[] }>;
  scopes?: unknown[];
  settings?: Record<string, string>;
  alwaysRescan?: (id: string) => boolean;
  currentPlaylistId?: string | null;
}

function setup(opts: Setup = {}) {
  const data = opts.data ?? { r1: { playlists: [playlist('p1', ['a'])], tracks: [track('a'), track('b', { missing: true })] } };
  const fileAccess = { listGrantedRoots: vi.fn(async () => opts.roots ?? [root('r1')]) };
  const libraryStore = {
    listPlaylists: vi.fn(async (id: string) => data[id]?.playlists ?? []),
    listTracks: vi.fn(async (id: string) => data[id]?.tracks ?? []),
    addLyricsScope: vi.fn(async () => {}),
    getLyricsScopes: vi.fn(async () => opts.scopes ?? []),
    getSetting: vi.fn(async (key: string) => opts.settings?.[key] ?? null),
    putSetting: vi.fn(async () => {}),
  };
  const playlistPlayer = {
    getState: vi.fn(() => ({ currentFileId: 'a' })),
    getNextFileId: vi.fn(() => 'b'),
    getCurrentPlaylistId: vi.fn(() => opts.currentPlaylistId ?? null),
    reconcilePlaylist: vi.fn(),
  };
  const services = {
    fileAccess,
    backgroundFileAccess: fileAccess,
    libraryStore,
    playlistPlayer,
    livePlayback: fakeLivePlayback().live,
    coverArtResizer: {},
    alwaysRescanRoot: opts.alwaysRescan ?? (() => false),
  } as unknown as Services;
  return { store: createStore(services), fileAccess, libraryStore, playlistPlayer };
}

beforeEach(() => vi.clearAllMocks());

describe('library slice', () => {
  it('rebuilds tracksById maps, memoized until the data changes', async () => {
    const { store } = setup();
    expect(selectRootsWithLibrary(store.getState())).toEqual([]);
    await store.dispatch(refreshLibrary());
    const first = selectRootsWithLibrary(store.getState());
    expect(first[0]!.tracksById.get('a')).toMatchObject({ fileId: 'a' });
    expect(selectRootsWithLibrary(store.getState())).toBe(first);
    store.dispatch(libraryErrorSet('x'));
    expect(selectRootsWithLibrary(store.getState())).toBe(first);
  });

  it('tracks missing files as a set', () => {
    const { store } = setup();
    store.dispatch(fileMissingReported('a'));
    store.dispatch(fileMissingReported('a'));
    store.dispatch(fileMissingReported('b'));
    expect([...selectMissingFileIds(store.getState())]).toEqual(['a', 'b']);
    store.dispatch(fileFoundReported('a'));
    expect([...selectMissingFileIds(store.getState())]).toEqual(['b']);
  });

  it('ticks the matched count down but never below zero or from null', () => {
    const { store } = setup();
    store.dispatch(matchedLyricsCountDecremented());
    expect(store.getState().library.matchedLyricsCount).toBeNull();
    store.dispatch(matchedLyricsCountSet(1));
    store.dispatch(matchedLyricsCountDecremented());
    store.dispatch(matchedLyricsCountDecremented());
    expect(store.getState().library.matchedLyricsCount).toBe(0);
  });
});

describe('refreshLibrary', () => {
  it('loads library roots, skips lyrics roots, and stops loading', async () => {
    const { store, libraryStore } = setup({ roots: [root('r1'), root('lyr', 'lyrics')] });
    const result = await store.dispatch(refreshLibrary());
    expect(result.map((r) => r.root.id)).toEqual(['r1']);
    expect(store.getState().library.grantedRoots.map((r) => r.id)).toEqual(['r1', 'lyr']);
    expect(store.getState().library.isLoadingRoots).toBe(false);
    expect(libraryStore.addLyricsScope).toHaveBeenCalledWith({ rootId: 'lyr', relativePath: '' });
  });

  it('only scans an empty root, or one the platform says to always rescan', async () => {
    const empty = setup({ data: { r1: { playlists: [], tracks: [] } } });
    await empty.store.dispatch(refreshLibrary());
    expect(mocks.scanRootCoordinated).toHaveBeenCalledTimes(1);

    mocks.scanRootCoordinated.mockClear();
    const populated = setup();
    await populated.store.dispatch(refreshLibrary());
    expect(mocks.scanRootCoordinated).not.toHaveBeenCalled();

    const always = setup({ alwaysRescan: (id) => id === 'r1' });
    await always.store.dispatch(refreshLibrary());
    expect(mocks.scanRootCoordinated).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing root: reports it, drops it, keeps the others', async () => {
    const { store, libraryStore } = setup({ roots: [root('r1'), root('bad')], data: { r1: { playlists: [], tracks: [track('a')] } } });
    libraryStore.listTracks.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('boom');
      return [track('a')];
    });
    const result = await store.dispatch(refreshLibrary());
    expect(result.map((r) => r.root.id)).toEqual(['r1']);
    expect(store.getState().library.error).toBe('boom');
  });

  it('does not report a pending-permission failure as an error', async () => {
    const { store, libraryStore } = setup();
    libraryStore.listTracks.mockRejectedValue(new FileAccessPermissionPendingError('r1'));
    const result = await store.dispatch(refreshLibrary());
    expect(result).toEqual([]);
    expect(store.getState().library.error).toBeNull();
  });

  it('rejects, and stops the loading state, if roots cannot be listed', async () => {
    const { store, fileAccess } = setup();
    fileAccess.listGrantedRoots.mockRejectedValue(new Error('no roots'));
    await expect(store.dispatch(refreshLibrary())).rejects.toThrow('no roots');
    expect(store.getState().library.isLoadingRoots).toBe(false);
  });

  it('prunes orphaned root data once per launch', async () => {
    const { store } = setup();
    await store.dispatch(refreshLibrary());
    await store.dispatch(refreshLibrary());
    expect(mocks.pruneOrphanedRootData).toHaveBeenCalledTimes(1);
  });

  it('runs the lyrics match only when scopes exist, excluding missing tracks, and seeds the count from last launch', async () => {
    const none = setup();
    await none.store.dispatch(refreshLibrary());
    expect(mocks.matchLibraryLyricsQueued).not.toHaveBeenCalled();
    expect(none.store.getState().library.matchedLyricsCount).toBeNull();

    const steps: string[] = [];
    const withScopes = setup({ scopes: [{ rootId: 'r1', relativePath: '' }], settings: { lyricsMatchedCount: '7' } });
    await withScopes.store.dispatch(refreshLibrary({ onStep: (s) => steps.push(s) }));
    expect(steps).toEqual(['listingFolders', 'scanningLibrary', 'scanningLyrics']);
    expect(withScopes.store.getState().library.matchedLyricsCount).toBe(7);
    const tracksArg = (mocks.matchLibraryLyricsQueued.mock.calls[0] as unknown as [unknown, unknown, unknown, TrackRecord[]])[3];
    expect(tracksArg.map((t) => t.fileId)).toEqual(['a']);
  });

  it('reconciles the now-playing playlist against the fresh scan', async () => {
    const onNowPlayingReconciled = vi.fn();
    const { store, playlistPlayer } = setup({ currentPlaylistId: 'p1' });
    await store.dispatch(refreshLibrary({ onNowPlayingReconciled }));
    expect(playlistPlayer.reconcilePlaylist).toHaveBeenCalledWith(['a']);
    expect(onNowPlayingReconciled).toHaveBeenCalledTimes(1);
  });

  it('refreshes the playing context (what the player resolves tracks through) from the fresh scan, but only for the playlist that is playing', async () => {
    const stale = { root: root('r1'), playlist: playlist('p1', ['old']), tracks: [track('old')] };
    const { store } = setup({ currentPlaylistId: 'p1' });
    store.dispatch(playingContextSet(stale));
    await store.dispatch(refreshLibrary());
    expect(store.getState().navigation.playingContext?.playlist.trackFileIds).toEqual(['a']);
    expect(store.getState().navigation.playingContext?.tracks.map((t) => t.fileId)).toEqual(['a', 'b']);

    const other = setup({ currentPlaylistId: 'p1' });
    other.store.dispatch(playingContextSet({ ...stale, playlist: playlist('p2', ['old']) }));
    await other.store.dispatch(refreshLibrary());
    expect(other.store.getState().navigation.playingContext?.playlist.trackFileIds).toEqual(['old']);
  });

  it('skips reconciling when nothing is playing', async () => {
    const { store, playlistPlayer } = setup();
    await store.dispatch(refreshLibrary());
    expect(playlistPlayer.reconcilePlaylist).not.toHaveBeenCalled();
  });
});
