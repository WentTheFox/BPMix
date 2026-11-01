import type { MutationDto } from '@beatseam/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantedRoot } from '../../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../../library-store/types';
import { ServerMode } from '../../server-mode/serverMode';
import { fakeServer, json, MemoryStore } from '../../server-mode/testing';

const mocks = vi.hoisted(() => ({
  movePlaylistTracks: vi.fn(async () => {}),
  removePlaylistTracks: vi.fn(async () => {}),
  addTracksToPlaylist: vi.fn(async () => {}),
}));
vi.mock('../../library-scan/editPlaylistTracks', () => ({ movePlaylistTracks: mocks.movePlaylistTracks, removePlaylistTracks: mocks.removePlaylistTracks }));
vi.mock('../../library-scan/addTracksToPlaylist', () => ({ addTracksToPlaylist: mocks.addTracksToPlaylist }));
// The reload after an edit is exercised in refreshLibrary's own tests; here it only needs to be asked for.
const reloads = vi.hoisted(() => ({ refresh: vi.fn(), sync: vi.fn() }));
vi.mock('../library/refreshLibrary', () => ({
  refreshLibrary: (options?: unknown) => () => {
    reloads.refresh(options);
    return Promise.resolve([]);
  },
  syncServerLibrary: () => () => Promise.resolve(null),
}));

import { createStore } from '../createStore';
import { grantedRootsLoaded } from '../library/librarySlice';
import type { Services } from '../services';
import { fakeLivePlayback } from '../testing';
import { addToPlaylistTrackSet, playlistScreenOpened } from './navigationSlice';
import {
  addPendingTrackToPlaylist,
  createUserPlaylistAndOpen,
  deleteOpenUserPlaylist,
  moveOpenPlaylistTracks,
  removeOpenPlaylistTracks,
  renameOpenUserPlaylist,
} from './playlistThunks';

const root = { id: 'Music', displayName: 'Music', kind: 'library', removable: false } as GrantedRoot;
const track = (fileId: string) => ({ fileId, rootId: 'Music', relativePath: `${fileId}.mp3`, sizeBytes: 1, lastModifiedMs: 1 }) as TrackRecord;
const playlist = (id: string, trackFileIds: string[], name = id): PlaylistRecord => ({ id, rootId: 'Music', fileId: id, name, trackFileIds });

async function setup() {
  const libraryStore = new MemoryStore();
  libraryStore.settings.set('serverMode.config', JSON.stringify({ url: 'https://s.example', token: 'bpd_tok', userName: 'Sam' }));
  libraryStore.settings.set('serverMode.roots', JSON.stringify([root]));
  const server = fakeServer();
  const sent: MutationDto[] = [];
  server.handler = (_path, init) => {
    const batch = (JSON.parse(String(init?.body)) as { mutations: MutationDto[] }).mutations;
    sent.push(...batch);
    return json({ results: batch.map((m) => ({ opId: m.opId, status: 'applied' })) });
  };
  const serverMode = new ServerMode({ store: libraryStore, deviceName: () => 'x', fetch: server.fetch });
  await serverMode.ready;
  const fileAccess = {};
  const services = {
    fileAccess,
    backgroundFileAccess: fileAccess,
    libraryStore,
    coverArtResizer: {},
    playlistPlayer: { getShuffleOrder: () => null },
    livePlayback: fakeLivePlayback().live,
    serverMode,
    now: () => 1,
  } as unknown as Services;
  const store = createStore(services);
  store.dispatch(grantedRootsLoaded([root]));
  const open = async (record: PlaylistRecord) => {
    await libraryStore.upsertPlaylist(record);
    for (const id of record.trackFileIds) await libraryStore.upsertTrack(track(id));
    store.dispatch(playlistScreenOpened({ root, playlist: record, tracks: record.trackFileIds.map(track) }));
  };
  const screen = () => {
    const { screen: s } = store.getState().navigation;
    return s.kind === 'playlist' ? s : null;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { store, libraryStore, sent, open, screen, settle };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('editing a playlist you built, in server mode', () => {
  it('reorders by replacing the order on the server, never writing a playlist file', async () => {
    const { store, libraryStore, sent, open, screen, settle } = await setup();
    await open(playlist('user:mine-00000001', ['a', 'b', 'c', 'd']));
    await store.dispatch(moveOpenPlaylistTracks(['a'], 'c', 'after', { rescan: vi.fn() }));
    await settle();
    expect(mocks.movePlaylistTracks).not.toHaveBeenCalled();
    expect(screen()!.playlist.trackFileIds).toEqual(['b', 'c', 'a', 'd']);
    expect((await libraryStore.listAllPlaylists())[0]!.trackFileIds).toEqual(['b', 'c', 'a', 'd']);
    expect(sent.map((m) => m.type)).toEqual(['playlist.setTracks']);
    expect(reloads.refresh).toHaveBeenCalledWith({ syncServer: false });
  });

  it('removes tracks, and adds the pending track at the end (a set-like merge) or the start', async () => {
    const { store, libraryStore, sent, open, screen, settle } = await setup();
    await open(playlist('user:mine-00000001', ['a', 'b', 'c']));
    await store.dispatch(removeOpenPlaylistTracks(['b'], { rescan: vi.fn() }));
    expect(screen()!.playlist.trackFileIds).toEqual(['a', 'c']);
    expect(mocks.removePlaylistTracks).not.toHaveBeenCalled();

    // The pending track is added from another screen (Unplaylisted) to this playlist.
    store.dispatch(playlistScreenOpened({ root, playlist: playlist('virtual:Music:unplaylisted', ['x', 'y']), tracks: [track('x'), track('y')] }));
    store.dispatch(addToPlaylistTrackSet(track('x')));
    await store.dispatch(addPendingTrackToPlaylist(playlist('user:mine-00000001', ['a', 'c']), 'end', { rescan: vi.fn() }));
    expect(mocks.addTracksToPlaylist).not.toHaveBeenCalled();
    expect(screen()!.playlist.trackFileIds).toEqual(['y']); // dropped from the Unplaylisted view
    await settle();
    expect((await libraryStore.listAllPlaylists())[0]!.trackFileIds).toEqual(['a', 'c', 'x']);
    expect(sent.map((m) => m.type)).toEqual(['playlist.removeTracks', 'playlist.addTracks']);
  });

  it('creates a playlist, opens it, renames it and deletes it', async () => {
    const { store, libraryStore, sent, screen, settle } = await setup();
    await libraryStore.upsertTrack(track('a'));
    const opened = vi.fn();
    await store.dispatch(createUserPlaylistAndOpen('Road trip', ['a'], { onOpened: opened }));
    expect(screen()!.playlist).toMatchObject({ name: 'Road trip', trackFileIds: ['a'] });
    expect(screen()!.playlist.id).toMatch(/^user:/);
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ name: 'Road trip' }), 'Music');

    await store.dispatch(renameOpenUserPlaylist('Road trip 2'));
    expect(screen()!.playlist.name).toBe('Road trip 2');
    await store.dispatch(deleteOpenUserPlaylist());
    expect(store.getState().navigation.screen.kind).toBe('library');
    expect(await libraryStore.listAllPlaylists()).toEqual([]);
    await settle();
    expect(sent.map((m) => m.type)).toEqual(['playlist.create', 'playlist.rename', 'playlist.delete']);
  });

  it('reports an error instead of failing silently, and leaves the screen alone', async () => {
    const { store, open, screen } = await setup();
    await open(playlist('user:mine-00000001', ['a']));
    await store.dispatch(renameOpenUserPlaylist('   '));
    expect(screen()!.playlist.name).toBe('user:mine-00000001');
    expect(store.getState().notifications.items[0]).toMatchObject({ detail: 'Give the playlist a name' });
  });

  it('leaves a library playlist file to the file-writing path, and does nothing for these thunks when not in server mode', async () => {
    const { store, open } = await setup();
    await open(playlist('Music:List.m3u8', ['a', 'b']));
    await store.dispatch(moveOpenPlaylistTracks(['a'], 'b', 'after', { rescan: vi.fn() }));
    expect(mocks.movePlaylistTracks).toHaveBeenCalledTimes(1); // not a user playlist: the file is what gets edited
  });
});
