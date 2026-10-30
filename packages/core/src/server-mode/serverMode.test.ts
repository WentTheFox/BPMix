import { encodeTrackKey, type SyncChangeDto, type TrackDto } from '@bpmix/api';
import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_ALGORITHM_VERSION } from '../analysis/analyzeTrack';
import { METADATA_PARSER_VERSION } from '../metadata/ensureMetadata';
import type { FileAccess } from '../file-access/types';
import { withServerCoverArt } from './serverCovers';
import { createModeAwareFileAccess, ServerModeUnsupportedError } from './serverFileAccess';
import type { OfflineLibrary } from '../offline/offlineLibrary';
import { normalizeServerUrl, ServerMode } from './serverMode';
import { fakeServer, json, MemoryStore } from './testing';

const ROOT = { id: 'Music', displayName: 'Music', kind: 'library' as const };

function track(name: string, over: Partial<TrackDto> = {}): TrackDto {
  return {
    id: encodeTrackKey(`Music:${name}.mp3`),
    rootId: 'Music',
    relativePath: `${name}.mp3`,
    sizeBytes: 1000,
    lastModifiedMs: 5,
    missing: false,
    title: name.toUpperCase(),
    artists: ['An Artist'],
    album: 'An Album',
    durationSeconds: 200,
    contentHash: 'a'.repeat(64),
    normalizationGain: 0.5,
    hasCover: true,
    hasLyrics: false,
    ...over,
  };
}
const trackChange = (t: TrackDto | null, name?: string): SyncChangeDto => ({ entity: 'track', id: t?.id ?? encodeTrackKey(`Music:${name}.mp3`), track: t });

const me = { id: 'u', username: 'sam', displayName: 'Sam', role: 'USER', enrolled: true, hasPassword: true, totpEnabled: true, passkeys: [], recoveryCodesRemaining: 3, authenticatedAtMs: null, via: 'device' };

async function signedIn(store = new MemoryStore(), server = fakeServer()) {
  store.settings.set('serverMode.config', JSON.stringify({ url: 'https://music.example.com', token: 'bpd_token', userName: 'Sam' }));
  const mode = new ServerMode({ store, deviceName: () => 'Test phone', fetch: server.fetch, now: () => 1_000 });
  await mode.ready;
  return { store, server, mode };
}

describe('normalizeServerUrl', () => {
  it.each([
    ['music.example.com', 'https://music.example.com'],
    ['https://music.example.com/', 'https://music.example.com'],
    ['  http://192.168.1.20:8080/some/path?x=1 ', 'http://192.168.1.20:8080'],
    ['localhost:8099', 'http://localhost:8099'],
  ])('turns %s into %s', (typed, expected) => expect(normalizeServerUrl(typed)).toBe(expected));

  it('refuses empty input and other schemes', () => {
    expect(() => normalizeServerUrl('  ')).toThrow('Enter the server address');
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow('http');
  });

  it('allows plain http only for private and local addresses', () => {
    for (const host of ['localhost:8099', '127.0.0.1', '10.1.2.3', '172.16.0.5', '172.31.255.1', '192.168.1.20:8080', '169.254.1.1', '100.100.1.1', '[::1]:8099', '[fd12:3456::1]', 'nas', 'music.local', 'box.home.arpa', 'pi.lan']) {
      expect(() => normalizeServerUrl(`http://${host}`), host).not.toThrow();
    }
    for (const host of ['music.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', '11.0.0.1', '[2001:db8::1]']) {
      expect(() => normalizeServerUrl(`http://${host}`), host).toThrow('https');
    }
  });

  it('defaults a bare address to http on the local network and https elsewhere', () => {
    expect(normalizeServerUrl('192.168.1.20:8080')).toBe('http://192.168.1.20:8080');
    expect(normalizeServerUrl('nas')).toBe('http://nas');
    expect(normalizeServerUrl('music.example.com')).toBe('https://music.example.com');
  });
});

describe('ServerMode secret storage', () => {
  const memorySecrets = (initial: string | null = null) => {
    let value = initial;
    return { get: async () => value, set: async (v: string | null) => void (value = v), peek: () => value };
  };

  it('keeps the device token out of the settings and restores it after a restart', async () => {
    const store = new MemoryStore();
    const secrets = memorySecrets();
    const server = fakeServer();
    server.handler = (path) => {
      if (path === '/api/v1/auth/device/code') return json({ deviceCode: 'dc', userCode: 'ABCD-EFGH', verificationUri: 'https://x/device', expiresInSeconds: 600 }, 201);
      if (path === '/api/v1/auth/device/wait') return json({ status: 'approved', token: 'bpd_secret', me });
      return json({}, 404);
    };
    const mode = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch, secretStore: secrets });
    await mode.ready;
    await mode.signInWithDeviceCode('music.example.com', () => undefined);
    expect(secrets.peek()).toBe('bpd_secret');
    expect(store.settings.get('serverMode.config')).not.toContain('bpd_secret');

    const restarted = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch, secretStore: secrets });
    await restarted.ready;
    expect(restarted.isActive()).toBe(true);
    expect(restarted.getApi()).not.toBeNull();
  });

  it('moves a token saved before secret storage existed into it', async () => {
    const store = new MemoryStore();
    store.settings.set('serverMode.config', JSON.stringify({ url: 'https://music.example.com', token: 'bpd_old', userName: 'Sam' }));
    const secrets = memorySecrets();
    const mode = new ServerMode({ store, deviceName: () => 'x', secretStore: secrets });
    await mode.ready;
    expect(mode.isActive()).toBe(true);
    expect(secrets.peek()).toBe('bpd_old');
    expect(store.settings.get('serverMode.config')).not.toContain('bpd_old');
  });

  it('is signed out when the secret is gone, and sign-out clears it', async () => {
    const store = new MemoryStore();
    store.settings.set('serverMode.config', JSON.stringify({ url: 'https://music.example.com', token: null, tokenInSecretStore: true, userName: 'Sam' }));
    const lost = new ServerMode({ store, deviceName: () => 'x', secretStore: memorySecrets(null) });
    await lost.ready;
    expect(lost.isActive()).toBe(false);

    const secrets = memorySecrets('bpd_token');
    const mode = new ServerMode({ store, deviceName: () => 'x', fetch: fakeServer().fetch, secretStore: secrets });
    await mode.ready;
    expect(mode.isActive()).toBe(true);
    await mode.signOut();
    expect(secrets.peek()).toBeNull();
  });
});

describe('ServerMode sign-in', () => {
  it('is inactive until signed in, and a signed-in app comes back signed in after a restart', async () => {
    const store = new MemoryStore();
    const server = fakeServer();
    const mode = new ServerMode({ store, deviceName: () => 'Pixel 8', fetch: server.fetch });
    await mode.ready;
    expect(mode.isActive()).toBe(false);
    expect(mode.getApi()).toBeNull();
    expect(await mode.sync()).toEqual({ kind: 'inactive', changed: false });

    server.handler = (path) => {
      if (path === '/api/v1/auth/device/code') return json({ deviceCode: 'dc', userCode: 'ABCD-EFGH', verificationUri: 'https://music.example.com/device?code=ABCD-EFGH', expiresInSeconds: 600 }, 201);
      if (path === '/api/v1/auth/device/wait') return json({ status: 'approved', token: 'bpd_secret', me });
      return json({}, 404);
    };
    const shown: unknown[] = [];
    const result = await mode.signInWithDeviceCode('music.example.com/', (p) => shown.push(p));
    // (the address had no scheme and a trailing slash: it is normalised)
    expect(server.calls[0]!.path).toBe('/api/v1/auth/device/code');
    expect(shown[0]).toMatchObject({ kind: 'code', userCode: 'ABCD-EFGH' });
    expect(result).toMatchObject({ token: 'bpd_secret' });
    expect(mode.isActive()).toBe(true);
    expect(mode.getStatus()).toMatchObject({ url: 'https://music.example.com', userName: 'Sam' });

    const restarted = new ServerMode({ store, deviceName: () => 'Pixel 8', fetch: server.fetch });
    await restarted.ready;
    expect(restarted.isActive()).toBe(true);
    expect(restarted.getStatus().userName).toBe('Sam');
  });

  it('reports a denied or expired request without signing in', async () => {
    const server = fakeServer();
    const mode = new ServerMode({ store: new MemoryStore(), deviceName: () => 'x', fetch: server.fetch });
    server.handler = (path) =>
      path.endsWith('/code') ? json({ deviceCode: 'dc', userCode: 'AAAA-BBBB', verificationUri: 'u', expiresInSeconds: 1 }, 201) : json({ status: 'denied' });
    expect(await mode.signInWithDeviceCode('https://x.example', () => undefined)).toEqual({ denied: true });
    expect(mode.isActive()).toBe(false);
  });

  it('a browser session (the web app on the server itself) signs in by cookie and signs out by ending the session', async () => {
    const store = new MemoryStore();
    const server = fakeServer();
    const seen: string[] = [];
    server.handler = (path, init) => {
      seen.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/v1/auth/me') return json(me);
      return new Response(null, { status: 204 });
    };
    const mode = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch, sameOrigin: true });
    await mode.ready;
    expect(mode.usesBrowserSession).toBe(true);
    expect(mode.isActive()).toBe(false);

    expect(await mode.connectSameOrigin()).toBe(true);
    expect(mode.isActive()).toBe(true);
    expect(mode.getStatus()).toMatchObject({ url: '', userName: 'Sam' });
    expect(server.calls[0]!.auth).toBeNull(); // no bearer token: the cookie does the work

    await mode.signOut();
    expect(seen).toContain('POST /api/v1/auth/logout');
    expect(seen).not.toContain('DELETE /api/v1/auth/me/token');
    expect(mode.isActive()).toBe(false);
  });

  it('does not connect when the page is not served by a BPMix server, or when the person has not finished enrolling', async () => {
    const server = fakeServer();
    const mode = new ServerMode({ store: new MemoryStore(), deviceName: () => 'x', fetch: server.fetch, sameOrigin: true });
    server.handler = () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }); // a static host's SPA fallback
    expect(await mode.connectSameOrigin()).toBe(false);
    server.handler = () => json({ ...me, enrolled: false });
    expect(await mode.connectSameOrigin()).toBe(false);
    server.handler = () => json({ message: 'Sign in required' }, 401);
    expect(await mode.connectSameOrigin()).toBe(false);
    expect(mode.isActive()).toBe(false);
  });

  it('signing out forgets the sign-in and the synced library', async () => {
    const { store, mode } = await signedIn();
    store.settings.set('serverMode.roots', JSON.stringify([ROOT]));
    await new ServerMode({ store, deviceName: () => 'x' }).ready;
    const again = new ServerMode({ store, deviceName: () => 'x' });
    await again.ready;
    await store.upsertTrack({ fileId: 'Music:a.mp3', rootId: 'Music', relativePath: 'a.mp3', sizeBytes: 1, lastModifiedMs: 1 });
    await store.upsertPlaylist({ id: 'Music:l.m3u8', rootId: 'Music', fileId: 'Music:l.m3u8', name: 'l', trackFileIds: [] });
    const sawRevoke: string[] = [];
    const server = fakeServer();
    server.handler = (path, init) => {
      sawRevoke.push(`${init?.method} ${path}`);
      return new Response(null, { status: 204 });
    };
    const withServer = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
    await withServer.ready;
    await withServer.signOut();
    expect(sawRevoke).toEqual(['DELETE /api/v1/auth/me/token']);
    expect(withServer.isActive()).toBe(false);
    await again.signOut(); // and signing out still works with no server to ask
    expect(again.isActive()).toBe(false);
    expect(store.tracks.size + store.playlists.size).toBe(0);
    void mode;
  });
});

describe('ServerMode sync', () => {
  it('takes a snapshot into the existing library records, with metadata the UI treats as scanned', async () => {
    const { store, server, mode } = await signedIn();
    const a = track('a');
    const b = track('b', { title: null, artists: [], album: null, durationSeconds: null, normalizationGain: null, hasCover: false });
    server.handler = (path) => {
      if (!path.startsWith('/api/v1/sync/snapshot')) return json({}, 404);
      return json({
        entities: [
          trackChange(a),
          trackChange(b),
          { entity: 'playlist', id: encodeTrackKey('Music:Mix.m3u8'), playlist: { id: encodeTrackKey('Music:Mix.m3u8'), rootId: 'Music', name: 'Mix', trackIds: [b.id, a.id] } },
          { entity: 'userPlaylist', id: 'my-list-0001', userPlaylist: { id: 'my-list-0001', name: 'Mine', trackIds: [a.id], updatedAtMs: 1 } },
        ],
        next: null,
        cursor: '42',
        roots: [ROOT, { id: 'Lyrics', displayName: 'Lyrics', kind: 'lyrics' }],
      });
    };

    expect(await mode.sync()).toEqual({ kind: 'snapshot', changed: true });

    expect(mode.roots()).toEqual([{ id: 'Music', displayName: 'Music', kind: 'library', removable: false }]); // lyrics-only roots are not libraries
    expect(await store.listTracks('Music')).toHaveLength(2);
    expect(store.tracks.get('Music:a.mp3')).toEqual({ fileId: 'Music:a.mp3', rootId: 'Music', relativePath: 'a.mp3', sizeBytes: 1000, lastModifiedMs: 5 });
    expect(store.metadata.get('Music:a.mp3')).toEqual({
      fileId: 'Music:a.mp3', title: 'A', artists: ['An Artist'], album: 'An Album', durationSeconds: 200,
      sizeBytes: 1000, lastModifiedMs: 5, parserVersion: METADATA_PARSER_VERSION, contentHash: 'a'.repeat(64),
    });
    expect(store.analysis.get('Music:a.mp3')).toMatchObject({ normalizationGain: 0.5, sizeBytes: 1000, lastModifiedMs: 5, algorithmVersion: ANALYSIS_ALGORITHM_VERSION });
    expect(store.analysis.has('Music:b.mp3')).toBe(false); // not analysed yet on the server
    expect(store.playlists.get('Music:Mix.m3u8')).toMatchObject({ name: 'Mix', rootId: 'Music', trackFileIds: ['Music:b.mp3', 'Music:a.mp3'] });
    expect(store.playlists.get('user:my-list-0001')).toMatchObject({ name: 'Mine', rootId: 'Music', trackFileIds: ['Music:a.mp3'] });
    expect(store.settings.get('serverMode.cursor')).toBe('42');
    expect(mode.getStatus()).toMatchObject({ lastSyncedAtMs: 1_000, offline: false, error: null });
    expect(server.calls[0]!.auth).toBe('Bearer bpd_token');
  });

  it('follows deltas afterwards, applying updates and removals, and reports whether anything changed', async () => {
    const { store, server, mode } = await signedIn();
    server.handler = () => json({ entities: [trackChange(track('a')), trackChange(track('b'))], next: null, cursor: '10', roots: [ROOT] });
    await mode.sync();

    server.handler = (path) => {
      expect(path).toBe('/api/v1/sync/changes?since=10&limit=500');
      return json({ changes: [trackChange(track('a', { title: 'Renamed' })), trackChange(null, 'b')], cursor: '12', hasMore: false, roots: [ROOT], totals: { tracks: 1, playlists: 0 } });
    };
    expect(await mode.sync()).toEqual({ kind: 'delta', changed: true });
    expect(store.metadata.get('Music:a.mp3')!.title).toBe('Renamed');
    expect(store.tracks.has('Music:b.mp3')).toBe(false);
    expect(store.settings.get('serverMode.cursor')).toBe('12');

    server.handler = () => json({ changes: [], cursor: '12', hasMore: false, roots: [ROOT], totals: { tracks: 1, playlists: 0 } });
    expect(await mode.sync()).toEqual({ kind: 'delta', changed: false });
  });

  it('saves its place page by page, so an interrupted check-in resumes instead of restarting', async () => {
    const { store, server, mode } = await signedIn();
    store.settings.set('serverMode.cursor', '5');
    store.settings.set('serverMode.roots', JSON.stringify([ROOT]));
    let page = 0;
    server.handler = () => {
      page++;
      if (page === 1) return json({ changes: [trackChange(track('a'))], cursor: '8', hasMore: true, roots: [ROOT], totals: { tracks: 1, playlists: 0 } });
      return json({ message: 'boom' }, 500);
    };
    expect((await mode.sync()).kind).toBe('failed');
    expect(store.settings.get('serverMode.cursor')).toBe('8'); // page one was kept
    expect(store.tracks.has('Music:a.mp3')).toBe(true);
  });

  it('keeps the cached library and says so when the server cannot be reached', async () => {
    const { store, server, mode } = await signedIn();
    server.handler = () => json({ entities: [trackChange(track('a'))], next: null, cursor: '3', roots: [ROOT] });
    await mode.sync();

    server.fetch = vi.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const offline = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
    await offline.ready;
    expect(await offline.sync()).toEqual({ kind: 'offline', changed: false });
    expect(offline.getStatus()).toMatchObject({ offline: true, error: null, active: true });
    expect(store.tracks.has('Music:a.mp3')).toBe(true);
    expect(offline.roots()).toEqual(mode.roots());
  });

  it('starts over with a snapshot when the server says its history no longer reaches us, and drops what is gone', async () => {
    const { store, server, mode } = await signedIn();
    server.handler = () => json({ entities: [trackChange(track('a')), trackChange(track('b'))], next: null, cursor: '10', roots: [ROOT] });
    await mode.sync();
    // A track from some other, non-server root must not be touched by the pruning.
    await store.upsertTrack({ fileId: 'Other:z.mp3', rootId: 'Other', relativePath: 'z.mp3', sizeBytes: 1, lastModifiedMs: 1 });

    server.handler = (path) => {
      if (path.startsWith('/api/v1/sync/changes')) return json({ code: 'resync_required', message: 'too old' }, 410);
      return json({ entities: [trackChange(track('a'))], next: null, cursor: '99', roots: [ROOT] });
    };
    expect(await mode.sync()).toEqual({ kind: 'snapshot', changed: true });
    expect([...store.tracks.keys()].sort()).toEqual(['Music:a.mp3', 'Other:z.mp3']);
    expect(store.settings.get('serverMode.cursor')).toBe('99');
  });

  it('repairs itself with a snapshot when its local counts no longer match the server, however the rows were lost', async () => {
    const { store, server, mode } = await signedIn();
    server.handler = () => json({ entities: [trackChange(track('a')), trackChange(track('b'))], next: null, cursor: '10', roots: [ROOT] });
    await mode.sync();

    // Something deleted a row locally (the feed will never mention it again: it didn't change on the server).
    await store.deleteTrack('Music:b.mp3');
    server.handler = (path) =>
      path.startsWith('/api/v1/sync/changes')
        ? json({ changes: [], cursor: '10', hasMore: false, roots: [ROOT], totals: { tracks: 2, playlists: 0 } })
        : json({ entities: [trackChange(track('a')), trackChange(track('b'))], next: null, cursor: '10', roots: [ROOT] });
    expect(await mode.sync()).toEqual({ kind: 'snapshot', changed: true });
    expect([...store.tracks.keys()].sort()).toEqual(['Music:a.mp3', 'Music:b.mp3']);

    // Counts agree again: back to cheap deltas. (The user's own playlists don't count towards the server's total.)
    await store.upsertPlaylist({ id: 'user:mine-0001', rootId: 'Music', fileId: 'user:mine-0001', name: 'Mine', trackFileIds: [] });
    server.handler = () => json({ changes: [], cursor: '10', hasMore: false, roots: [ROOT], totals: { tracks: 2, playlists: 0 } });
    expect(await mode.sync()).toEqual({ kind: 'delta', changed: false });
  });

  it('pages a snapshot, and only ever runs one check-in at a time', async () => {
    const { server, mode } = await signedIn();
    const pages = [
      { entities: [trackChange(track('a'))], next: 'p2', cursor: '7', roots: [ROOT] },
      { entities: [trackChange(track('b'))], next: null, cursor: '8', roots: [ROOT] },
    ];
    server.handler = (path) => json(path.includes('after=p2') ? pages[1] : pages[0]);
    const [first, second] = await Promise.all([mode.sync(), mode.sync()]);
    expect(first).toBe(second === first ? second : first);
    expect(server.calls.filter((c) => c.path.startsWith('/api/v1/sync/snapshot'))).toHaveLength(2); // two pages, not four
    expect(mode.getStatus().syncing).toBe(false);
  });

  it('stops being signed in, but keeps the library, when the server rejects the token', async () => {
    const { store, server, mode } = await signedIn();
    server.handler = () => json({ entities: [trackChange(track('a'))], next: null, cursor: '1', roots: [ROOT] });
    await mode.sync();
    server.handler = () => json({ message: 'Sign in required' }, 401);
    expect(await mode.sync()).toEqual({ kind: 'signedOut', changed: false });
    expect(mode.isActive()).toBe(false);
    expect(mode.getStatus().error).toMatch(/signed out/i);
    expect(store.tracks.has('Music:a.mp3')).toBe(true);
  });

  it('notifies subscribers as a sync starts and finishes', async () => {
    const { server, mode } = await signedIn();
    server.handler = () => json({ entities: [], next: null, cursor: '1', roots: [ROOT] });
    const seen: boolean[] = [];
    const stop = mode.subscribe((s) => seen.push(s.syncing));
    await mode.sync();
    stop();
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('refreshes stale cover art when a file changes under the same name', async () => {
    const { store, server, mode } = await signedIn();
    server.handler = () => json({ entities: [trackChange(track('a'))], next: null, cursor: '1', roots: [ROOT] });
    await mode.sync();
    await store.putCoverArt('Music:a.mp3', { mimeType: 'image/webp', data: new Uint8Array([1]) });
    server.handler = () => json({ changes: [trackChange(track('a', { contentHash: 'b'.repeat(64) }))], cursor: '2', hasMore: false, roots: [ROOT], totals: { tracks: 1, playlists: 0 } });
    await mode.sync();
    expect(store.covers.has('Music:a.mp3')).toBe(false);
  });
});

describe('mode-aware file access', () => {
  const local: FileAccess = {
    requestRoot: vi.fn(async () => ({ id: 'local', displayName: 'Local' })),
    listGrantedRoots: vi.fn(async () => [{ id: 'local', displayName: 'Local' }]),
    revokeRoot: vi.fn(async () => undefined),
    listDirectory: vi.fn(async () => []),
    readFileBytes: vi.fn(async () => new ArrayBuffer(3)),
    readFileText: vi.fn(async () => 'local text'),
    writeFileText: vi.fn(async () => undefined),
    getStreamUrl: vi.fn(() => 'file://x'),
    getContentHash: vi.fn(async () => 'hash'),
  };
  const ref = { id: 'Music:a b.mp3', name: 'a b.mp3', relativePath: 'a b.mp3', sizeBytes: 1, lastModifiedMs: 1 };

  it('uses local folders while signed out', async () => {
    const mode = new ServerMode({ store: new MemoryStore(), deviceName: () => 'x' });
    await mode.ready;
    const access = createModeAwareFileAccess(local, mode);
    expect(await access.listGrantedRoots()).toEqual([{ id: 'local', displayName: 'Local' }]);
    expect(access.getStreamUrl?.(ref)).toBe('file://x');
    expect(await access.readFileText(ref)).toBe('local text');
  });

  it('serves the server library and its audio once signed in, with no folder operations', async () => {
    const { store, server, mode } = await signedIn();
    store.settings.set('serverMode.roots', JSON.stringify([{ ...ROOT, removable: false }])); // as a sync stores them
    const ready = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
    await ready.ready;
    server.handler = (path) => (path === `/api/v1/tracks/${encodeTrackKey(ref.id)}/stream` ? new Response(new Uint8Array([9, 8, 7]).buffer) : json({}, 404));
    const access = createModeAwareFileAccess(local, ready);

    expect(await access.listGrantedRoots()).toEqual([{ id: 'Music', displayName: 'Music', kind: 'library', removable: false }]);
    expect(Array.from(new Uint8Array(await access.readFileBytes(ref)))).toEqual([9, 8, 7]);
    expect(server.calls[server.calls.length - 1]).toMatchObject({ auth: 'Bearer bpd_token' });
    expect(access.getStreamUrl?.(ref)).toBeUndefined(); // metadata comes from the sync, not from reading files
    expect(await access.getContentHash?.(ref)).toBeNull();
    await expect(access.requestRoot()).rejects.toBeInstanceOf(ServerModeUnsupportedError);
    await expect(access.writeFileText('Music', 'x.m3u8', '')).rejects.toBeInstanceOf(ServerModeUnsupportedError);
    expect(await access.listDirectory('Music')).toEqual([]);
    expect(local.readFileBytes).not.toHaveBeenCalledWith(ref, expect.anything());
    void mode;
  });
});

describe('offline playback through the file access', () => {
  const local = {} as FileAccess;
  const ref = { id: 'Music:a.mp3', name: 'a.mp3', relativePath: 'a.mp3', sizeBytes: 1, lastModifiedMs: 1 };

  it('plays a downloaded copy with no request at all, and goes to the network for anything else', async () => {
    const { store, server } = await signedIn();
    const mode = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
    await mode.ready;
    const stored = new Uint8Array([7, 7]).buffer;
    const offline = { read: vi.fn(async (id: string) => (id === 'Music:a.mp3' ? stored : null)) } as unknown as OfflineLibrary;
    server.handler = () => new Response(new Uint8Array([1, 2, 3]).buffer);
    const access = createModeAwareFileAccess(local, mode, offline);

    expect(await access.readFileBytes(ref)).toBe(stored);
    expect(server.calls).toHaveLength(0);
    const other = { ...ref, id: 'Music:b.mp3' };
    expect(Array.from(new Uint8Array(await access.readFileBytes(other)))).toEqual([1, 2, 3]);
    expect(server.calls).toHaveLength(1);
  });

  it('fails with a network error, not a wrong file, when the track is not downloaded and the server is unreachable', async () => {
    const { store, server } = await signedIn();
    server.fetch = vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    const mode = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
    await mode.ready;
    const offline = { read: vi.fn(async () => null) } as unknown as OfflineLibrary;
    await expect(createModeAwareFileAccess(local, mode, offline).readFileBytes(ref)).rejects.toMatchObject({ name: 'NetworkError' });
  });
});

describe('server cover art', () => {
  async function setup() {
    const { store, server, mode } = await signedIn();
    const covered = withServerCoverArt(store, mode);
    return { store, server, mode, covered };
  }
  const png = () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200, headers: { 'content-type': 'image/webp; charset=binary' } });

  it('fetches art the first time it is asked for, stores it, and does not ask again', async () => {
    const { store, server, covered } = await setup();
    server.handler = () => png();
    expect(await covered.getCoverArt('Music:a.mp3')).toBe('file://Music:a.mp3.webp');
    expect(store.covers.get('Music:a.mp3')).toBe('file://Music:a.mp3.webp');
    expect(await covered.getCoverArt('Music:a.mp3')).toBe('file://Music:a.mp3.webp');
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.path).toBe(`/api/v1/tracks/${encodeTrackKey('Music:a.mp3')}/cover`);
  });

  it('shares one request between simultaneous askers, and remembers "no art" for the session', async () => {
    const { server, covered } = await setup();
    server.handler = () => json({ message: 'No cover art' }, 404);
    const [a, b] = await Promise.all([covered.getCoverArt('Music:x.mp3'), covered.getCoverArt('Music:x.mp3')]);
    expect([a, b]).toEqual([null, null]);
    expect(await covered.getCoverArt('Music:x.mp3')).toBeNull();
    expect(server.calls).toHaveLength(1);
  });

  it('gives up quietly while offline, and tries again next time rather than remembering', async () => {
    const { server, covered } = await setup();
    server.fetch = vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    // (a fresh ServerMode bound to the failing fetch)
    const store = new MemoryStore();
    store.settings.set('serverMode.config', JSON.stringify({ url: 'https://x', token: 't', userName: null }));
    const mode = new ServerMode({ store, deviceName: () => 'x', fetch: server.fetch });
    await mode.ready;
    const offline = withServerCoverArt(store, mode);
    expect(await offline.getCoverArt('Music:a.mp3')).toBeNull();
    expect(await offline.getCoverArt('Music:a.mp3')).toBeNull();
    expect(server.fetch).toHaveBeenCalledTimes(2);
    void covered;
  });

  it('passes everything else through untouched, and does nothing when signed out', async () => {
    const store = new MemoryStore();
    const mode = new ServerMode({ store, deviceName: () => 'x' });
    await mode.ready;
    const covered = withServerCoverArt(store, mode);
    await covered.putSetting('k', 'v');
    expect(await covered.getSetting('k')).toBe('v');
    expect(await covered.getCoverArt('Music:a.mp3')).toBeNull();
  });
});
