import { encodeTrackKey, type MutationDto } from '@beatseam/api';
import { describe, expect, it, vi } from 'vitest';
import { ServerMode } from './serverMode';
import { fakeServer, json, MemoryStore } from './testing';
import { addToUserPlaylist, createUserPlaylist, deleteUserPlaylist, isUserPlaylistId, removeFromUserPlaylist, renameUserPlaylist, setUserPlaylistTracks } from './userPlaylists';

const ROOT = { id: 'Music', displayName: 'Music', kind: 'library' as const, removable: false };
const key = (name: string) => encodeTrackKey(`Music:${name}.mp3`);
const id = (name: string) => `Music:${name}.mp3`;

/** A signed-in ServerMode with a root, whose server records every mutation request. */
async function setup(options: { online?: boolean } = {}) {
  const store = new MemoryStore();
  store.settings.set('serverMode.config', JSON.stringify({ url: 'https://s.example', token: 'bpd_tok', userName: 'Sam' }));
  store.settings.set('serverMode.roots', JSON.stringify([ROOT]));
  const server = fakeServer();
  const sent: MutationDto[][] = [];
  let online = options.online ?? true;
  server.handler = (path, init) => {
    if (!online) throw new TypeError('Network request failed');
    if (path === '/api/v1/mutations') {
      const batch = (JSON.parse(String(init?.body)) as { mutations: MutationDto[] }).mutations;
      sent.push(batch);
      return json({ results: batch.map((m) => ({ opId: m.opId, status: 'applied' })) });
    }
    return json({ message: 'unscripted' }, 500);
  };
  const mode = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
  await mode.ready;
  const deps = { store, serverMode: mode };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { store, server, mode, deps, sent, settle, setOnline: (value: boolean) => (online = value) };
}

describe('user playlists', () => {
  it('creates a playlist locally at once and sends the creation to the server', async () => {
    const { deps, store, sent, settle } = await setup();
    const playlist = await createUserPlaylist(deps, '  Road trip  ', [id('a'), id('b')]);
    expect(isUserPlaylistId(playlist.id)).toBe(true);
    expect(store.playlists.get(playlist.id)).toMatchObject({ rootId: 'Music', name: 'Road trip', trackFileIds: [id('a'), id('b')] });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toMatchObject({ type: 'playlist.create', name: 'Road trip', trackIds: [key('a'), key('b')], id: playlist.id.slice('user:'.length) });
    expect(sent[0]![0]!.opId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('adds at the end as a set-like operation, and at the start by replacing the order', async () => {
    const { deps, store, sent, settle } = await setup();
    const p = await createUserPlaylist(deps, 'Mix', [id('a')]);
    await settle();
    sent.length = 0;

    await addToUserPlaylist(deps, p.id, [id('b'), id('a'), id('b'), id('c')], 'end'); // a is already there; b repeats
    expect(store.playlists.get(p.id)!.trackFileIds).toEqual([id('a'), id('b'), id('c')]);
    await settle();
    expect(sent[0]![0]).toMatchObject({ type: 'playlist.addTracks', trackIds: [key('b'), key('c')] });

    await addToUserPlaylist(deps, p.id, [id('z')], 'start');
    expect(store.playlists.get(p.id)!.trackFileIds).toEqual([id('z'), id('a'), id('b'), id('c')]);
    await settle();
    expect(sent[1]![0]).toMatchObject({ type: 'playlist.setTracks', trackIds: [key('z'), key('a'), key('b'), key('c')] });

    sent.length = 0;
    await addToUserPlaylist(deps, p.id, [id('a')], 'end'); // nothing new: nothing to send
    await settle();
    expect(sent).toEqual([]);
  });

  it('removes, reorders, renames and deletes', async () => {
    const { deps, store, sent, settle } = await setup();
    const p = await createUserPlaylist(deps, 'Mix', [id('a'), id('b'), id('c')]);
    await settle();
    sent.length = 0;

    await removeFromUserPlaylist(deps, p.id, [id('b')]);
    expect(store.playlists.get(p.id)!.trackFileIds).toEqual([id('a'), id('c')]);
    await setUserPlaylistTracks(deps, p.id, [id('c'), id('a')]);
    expect(store.playlists.get(p.id)!.trackFileIds).toEqual([id('c'), id('a')]);
    await renameUserPlaylist(deps, p.id, 'Better mix');
    expect(store.playlists.get(p.id)!.name).toBe('Better mix');
    await deleteUserPlaylist(deps, p.id);
    expect(store.playlists.has(p.id)).toBe(false);
    await settle();

    expect(sent.flat().map((m) => m.type)).toEqual(['playlist.removeTracks', 'playlist.setTracks', 'playlist.rename', 'playlist.delete']);
    expect(new Set(sent.flat().map((m) => m.opId)).size).toBe(4); // every operation has its own id
  });

  it('refuses what cannot work: no root yet, an empty name, a playlist that is gone', async () => {
    const { deps, store } = await setup();
    await expect(createUserPlaylist(deps, '   ')).rejects.toThrow('Give the playlist a name');
    await expect(addToUserPlaylist(deps, 'user:nope', [id('a')])).rejects.toThrow('no longer exists');
    await expect(renameUserPlaylist(deps, 'user:nope', 'x')).rejects.toThrow('no longer exists');
    store.settings.set('serverMode.roots', '');
    const fresh = new ServerMode({ store, deviceName: () => 'x' });
    await fresh.ready;
    await expect(createUserPlaylist({ store, serverMode: fresh }, 'Mix')).rejects.toThrow('Sync with the server');
  });

  it('works with no connection: edits apply locally, wait in the queue, and are sent (once) when the server is back', async () => {
    const { deps, store, mode, server, sent, settle, setOnline } = await setup({ online: false });
    const p = await createUserPlaylist(deps, 'Offline mix', [id('a')]);
    await addToUserPlaylist(deps, p.id, [id('b')]);
    await settle();
    expect(store.playlists.get(p.id)!.trackFileIds).toEqual([id('a'), id('b')]); // visible and usable right away
    expect(mode.mutations.getState().pending).toBe(2);
    expect(sent).toEqual([]);

    // The app is restarted while still offline: the queue survives.
    const restarted = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
    await restarted.ready;
    await restarted.mutations.ready;
    expect(restarted.mutations.getState().pending).toBe(2);

    setOnline(true);
    server.handler = (path, init) => {
      if (path === '/api/v1/mutations') {
        const batch = (JSON.parse(String(init?.body)) as { mutations: MutationDto[] }).mutations;
        sent.push(batch);
        return json({ results: batch.map((m) => ({ opId: m.opId, status: 'applied' })) });
      }
      // The check-in that follows the flush: the server's version of the playlist comes back and replaces ours.
      if (path.startsWith('/api/v1/sync/snapshot'))
        return json({
          entities: [{ entity: 'userPlaylist', id: p.id.slice('user:'.length), userPlaylist: { id: p.id.slice('user:'.length), name: 'Offline mix', trackIds: [key('a'), key('b'), key('from-other-device')], updatedAtMs: 1 } }],
          next: null,
          cursor: '5',
          roots: [{ id: 'Music', displayName: 'Music', kind: 'library' }],
        });
      return json({}, 404);
    };
    expect((await restarted.sync()).kind).toBe('snapshot');
    expect(sent.flat().map((m) => m.type)).toEqual(['playlist.create', 'playlist.addTracks']);
    expect(restarted.mutations.getState().pending).toBe(0);
    expect(store.playlists.get(p.id)!.trackFileIds).toEqual([id('a'), id('b'), id('from-other-device')]);
  });

  it("never sends one account's queued changes to another", async () => {
    const { deps, mode, sent, settle, setOnline } = await setup({ online: false });
    await createUserPlaylist(deps, 'Private', [id('a')]);
    await settle();
    expect(mode.mutations.getState().pending).toBe(1);
    await mode.signOut();
    expect(mode.mutations.getState().pending).toBe(0);
    setOnline(true);
    await settle();
    expect(sent).toEqual([]);
  });
});

describe('the mutation queue', () => {
  it('drops what the server refuses for good, reports why, and keeps going', async () => {
    const { deps, mode, server, settle } = await setup();
    server.handler = (path, init) => {
      const batch = (JSON.parse(String(init?.body)) as { mutations: MutationDto[] }).mutations;
      return json({ results: batch.map((m) => (m.type === 'playlist.rename' ? { opId: m.opId, status: 'rejected', error: 'No such playlist' } : { opId: m.opId, status: 'applied' })) });
    };
    await mode.mutations.enqueue({ type: 'playlist.rename', id: 'ghost-playlist-1', name: 'x' });
    await mode.mutations.enqueue({ type: 'setting.delete', key: 'k' });
    await settle();
    expect(mode.mutations.getState().pending).toBe(0);
    expect(mode.mutations.getState().rejected).toEqual([{ opId: expect.any(String), error: 'No such playlist' }]);
    void deps;
  });

  it('keeps everything when the server errors, and sends in batches of 50', async () => {
    const { mode, server, sent, settle } = await setup();
    let failing = true;
    server.handler = (path, init) => {
      if (failing) return json({ message: 'boom' }, 500);
      const batch = (JSON.parse(String(init?.body)) as { mutations: MutationDto[] }).mutations;
      sent.push(batch);
      return json({ results: batch.map((m) => ({ opId: m.opId, status: 'applied' })) });
    };
    for (let i = 0; i < 120; i++) await mode.mutations.enqueue({ type: 'setting.set', key: `k${i}`, value: 'v' });
    await settle();
    expect(mode.mutations.getState().pending).toBe(120);

    failing = false;
    await mode.mutations.flush();
    expect(sent.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(mode.mutations.getState().pending).toBe(0);
  });

  it('runs one flush at a time', async () => {
    const { mode, server, settle } = await setup();
    const spy = vi.fn(async () => json({ results: [] }));
    server.handler = spy as never;
    await mode.mutations.enqueue({ type: 'setting.delete', key: 'a' });
    await settle();
    spy.mockClear();
    server.handler = (async (_p: string, init?: RequestInit) => {
      spy();
      const batch = (JSON.parse(String(init?.body)) as { mutations: MutationDto[] }).mutations;
      await new Promise((r) => setTimeout(r, 5));
      return json({ results: batch.map((m) => ({ opId: m.opId, status: 'applied' })) });
    }) as never;
    await Promise.all([mode.mutations.flush(), mode.mutations.flush(), mode.mutations.flush()]);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
