import { ApiClient, ApiError, NetworkError } from '@bpmix/api';
import { describe, expect, it, vi } from 'vitest';
import type { AnalysisResult, LibraryStore, PlaybackState, PlaylistRecord, TrackRecord } from '../library-store/types';
import type { CoverArtBytes, TrackMetadata } from '../metadata/types';
import type { ServerStatus } from '../server-mode/serverMode';
import { OfflineLibrary } from './offlineLibrary';
import type { OfflineBackend } from './types';

class MemoryStore implements LibraryStore {
  settings = new Map<string, string>();
  metadata = new Map<string, TrackMetadata>();
  async upsertTrack(_t: TrackRecord) {}
  async deleteTrack() {}
  async upsertPlaylist(_p: PlaylistRecord) {}
  async deletePlaylist() {}
  async listTracks() { return []; }
  async listPlaylists() { return []; }
  async listAllTracks() { return []; }
  async listAllPlaylists() { return []; }
  async getAnalysis(): Promise<AnalysisResult | null> { return null; }
  async putAnalysis() {}
  async getMetadata(id: string) { return this.metadata.get(id) ?? null; }
  async putMetadata(m: TrackMetadata) { this.metadata.set(m.fileId, m); }
  async getCoverArt() { return null; }
  async putCoverArt(_id: string, _a: CoverArtBytes | null) {}
  async getPlaybackState(): Promise<PlaybackState | null> { return null; }
  async putPlaybackState() {}
  async getLyricsScopes() { return []; }
  async addLyricsScope() {}
  async removeLyricsScope() {}
  async getLyricsAssignment() { return null; }
  async putLyricsAssignment() {}
  async getSetting(key: string) { return this.settings.get(key) ?? null; }
  async putSetting(key: string, value: string) { this.settings.set(key, value); }
}

const sha = (c: string) => c.repeat(64).slice(0, 64);
const meta = (fileId: string, contentHash: string | null): TrackMetadata => ({
  fileId, title: null, artists: [], album: null, durationSeconds: null, sizeBytes: 1, lastModifiedMs: 1, parserVersion: 1, contentHash,
});

/** A backend whose downloads finish when the test says so (or fail as scripted). */
class FakeBackend implements OfflineBackend {
  files = new Map<string, { bytes: ArrayBuffer; sha256: string }>();
  pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  started: string[] = [];
  /** Hash the "server" delivers for each file; defaults to sha('a'). */
  deliver = new Map<string, string>();
  failWith = new Map<string, unknown[]>();
  headersSeen: Record<string, string>[] = [];
  urlsSeen: string[] = [];

  download: OfflineBackend['download'] = (req) => {
    this.started.push(req.fileId);
    this.headersSeen.push(req.headers);
    this.urlsSeen.push(req.url);
    const scripted = this.failWith.get(req.fileId);
    if (scripted && scripted.length > 0) return Promise.reject(scripted.shift());
    return new Promise((resolve, reject) => {
      const finish = () => {
        const sha256 = this.deliver.get(req.fileId) ?? sha('a');
        const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
        this.files.set(req.fileId, { bytes, sha256 });
        req.onProgress?.(4);
        resolve({ sizeBytes: 4, sha256 });
      };
      req.signal.addEventListener('abort', () => reject(new Error('aborted')));
      this.pending.set(req.fileId, { resolve: finish, reject });
      if (this.autoFinish) finish();
    });
  };
  autoFinish = false;
  async read(id: string) { return this.files.get(id)?.bytes ?? null; }
  async remove(id: string) { this.files.delete(id); }
  async list() { return [...this.files].map(([fileId, f]) => ({ fileId, sizeBytes: f.bytes.byteLength })); }
  complete(id: string) { this.pending.get(id)?.resolve(); this.pending.delete(id); }
}

function fakeServer(signedIn = true) {
  let status: ServerStatus = { active: signedIn, url: 'https://s.example', userName: 'Sam', lastSyncedAtMs: 1, syncing: false, offline: false, error: null };
  const listeners = new Set<(s: ServerStatus) => void>();
  const api = new ApiClient({ baseUrl: 'https://s.example', getToken: () => 'bpd_tok' });
  return {
    getApi: () => (signedIn ? api : null),
    getStatus: () => status,
    subscribe: (l: (s: ServerStatus) => void) => (listeners.add(l), () => listeners.delete(l)),
    set(patch: Partial<ServerStatus>) {
      status = { ...status, ...patch };
      for (const l of listeners) l(status);
    },
  };
}

async function setup(options: { signedIn?: boolean; store?: MemoryStore; backend?: FakeBackend; concurrency?: number; maxAttempts?: number } = {}) {
  const store = options.store ?? new MemoryStore();
  const backend = options.backend ?? new FakeBackend();
  const server = fakeServer(options.signedIn ?? true);
  let clock = 1_000;
  const library = new OfflineLibrary({ backend, store, server, now: () => clock++, concurrency: options.concurrency, maxAttempts: options.maxAttempts, retryDelayMs: () => 0 });
  await library.ready;
  return { store, backend, server, library };
}

/** Lets promise chains and zero-delay timers settle. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('OfflineLibrary downloads', () => {
  it('downloads queued tracks a couple at a time, with auth, and reports progress and totals', async () => {
    const { library, backend } = await setup({ concurrency: 2 });
    library.request(['Music:a.mp3', 'Music:b.mp3', 'Music:c.mp3']);
    await settle();
    expect(backend.started).toEqual(['Music:a.mp3', 'Music:b.mp3']); // the third waits its turn
    expect(library.getState()).toMatchObject({ activeCount: 2, queuedCount: 1 });
    expect(backend.headersSeen[0]).toMatchObject({ authorization: 'Bearer bpd_tok' });
    expect(backend.urlsSeen[0]).toMatch(/^https:\/\/s\.example\/api\/v1\/tracks\/[A-Za-z0-9_-]+\/stream$/);

    backend.complete('Music:a.mp3');
    await settle();
    expect(backend.started).toContain('Music:c.mp3');
    expect(library.isAvailable('Music:a.mp3')).toBe(true);
    expect(library.isPinned('Music:a.mp3')).toBe(true);
    backend.complete('Music:b.mp3');
    backend.complete('Music:c.mp3');
    await settle();
    expect(library.getState()).toMatchObject({ downloadedCount: 3, downloadedBytes: 12, activeCount: 0, queuedCount: 0, failures: [] });
  });

  it('does nothing twice: a track already stored or already queued is not downloaded again', async () => {
    const { library, backend } = await setup();
    backend.autoFinish = true;
    library.request(['Music:a.mp3']);
    library.request(['Music:a.mp3']);
    await settle();
    library.request(['Music:a.mp3']);
    await settle();
    expect(backend.started).toEqual(['Music:a.mp3']);
  });

  it('checks the file against the hash the server gave, and refuses (after retries) one that does not match', async () => {
    const { library, backend, store } = await setup({ maxAttempts: 3 });
    backend.autoFinish = true;
    store.metadata.set('Music:ok.mp3', meta('Music:ok.mp3', sha('a')));
    store.metadata.set('Music:bad.mp3', meta('Music:bad.mp3', sha('b'))); // the backend delivers sha('a'): a mismatch
    library.request(['Music:ok.mp3', 'Music:bad.mp3']);
    await settle();
    expect(library.isAvailable('Music:ok.mp3')).toBe(true);
    expect(library.isAvailable('Music:bad.mp3')).toBe(false);
    expect(backend.files.has('Music:bad.mp3')).toBe(false); // the bad copy is not left on disk
    expect(backend.started.filter((id) => id === 'Music:bad.mp3')).toHaveLength(3);
    expect(library.getState().failures).toEqual([{ fileId: 'Music:bad.mp3', message: 'The downloaded file does not match what the server has' }]);
  });

  it('retries a flaky download and succeeds', async () => {
    const { library, backend } = await setup({ maxAttempts: 3 });
    backend.autoFinish = true;
    backend.failWith.set('Music:flaky.mp3', [new Error('HTTP 500'), new Error('HTTP 502')]);
    library.request(['Music:flaky.mp3']);
    await settle();
    expect(library.isAvailable('Music:flaky.mp3')).toBe(true);
    expect(backend.started.filter((id) => id === 'Music:flaky.mp3')).toHaveLength(3);
    expect(library.getState().failures).toEqual([]);
  });

  it('pauses when the server cannot be reached, keeps the queue, and carries on when it can', async () => {
    const { library, backend, server } = await setup({ concurrency: 1 });
    backend.autoFinish = true;
    backend.failWith.set('Music:a.mp3', [new NetworkError(new Error('offline'))]);
    server.set({ offline: true });
    library.request(['Music:a.mp3', 'Music:b.mp3']);
    await settle();
    expect(library.getState()).toMatchObject({ paused: true, downloadedCount: 0, failures: [] });
    expect(library.getState().queuedCount).toBeGreaterThan(0);

    server.set({ offline: false }); // a check-in got through
    await settle();
    expect(library.getState()).toMatchObject({ paused: false, downloadedCount: 2, queuedCount: 0 });
  });

  it('gives up at once on a track that is gone from the server, and pauses if the sign-in lapsed', async () => {
    const { library, backend } = await setup();
    backend.autoFinish = true;
    backend.failWith.set('Music:gone.mp3', [new ApiError(404, 'Not Found')]);
    library.request(['Music:gone.mp3']);
    await settle();
    expect(library.getState().failures).toEqual([{ fileId: 'Music:gone.mp3', message: 'No longer on the server' }]);
    expect(backend.started).toEqual(['Music:gone.mp3']); // not retried

    backend.failWith.set('Music:x.mp3', [new ApiError(401, 'Unauthorized')]);
    library.request(['Music:x.mp3']);
    await settle();
    expect(library.getState().paused).toBe(true);
    expect(library.getState().failures.map((f) => f.message)).toContain('Signed out by the server');
  });

  it('cancels what is in flight and queued, keeping what already arrived', async () => {
    const { library, backend } = await setup({ concurrency: 1 });
    backend.autoFinish = true;
    library.request(['Music:done.mp3']);
    await settle();
    backend.autoFinish = false;
    library.request(['Music:slow.mp3', 'Music:waiting.mp3']);
    await settle();
    expect(library.getState()).toMatchObject({ activeCount: 1, queuedCount: 1 });
    library.cancelAll();
    await settle();
    expect(library.getState()).toMatchObject({ activeCount: 0, queuedCount: 0, downloadedCount: 1 });
    expect(library.getState().failures).toEqual([]); // a cancellation is not a failure
  });

  it('does not download when not signed in', async () => {
    const { library, backend } = await setup({ signedIn: false });
    library.request(['Music:a.mp3']);
    await settle();
    expect(backend.started).toEqual([]);
    expect(library.getState().paused).toBe(true);
  });
});

describe('OfflineLibrary reading', () => {
  it('hands back stored bytes, and null for what is not stored', async () => {
    const { library, backend } = await setup();
    backend.autoFinish = true;
    library.request(['Music:a.mp3']);
    await settle();
    expect(Array.from(new Uint8Array((await library.read('Music:a.mp3'))!))).toEqual([1, 2, 3, 4]);
    expect(await library.read('Music:never.mp3')).toBeNull();
  });

  it('drops a copy the server has since replaced, and fetches it again if it was one to keep', async () => {
    const { library, backend, store } = await setup();
    backend.autoFinish = true;
    store.metadata.set('Music:a.mp3', meta('Music:a.mp3', sha('a')));
    library.request(['Music:a.mp3']);
    await settle();
    expect(library.isAvailable('Music:a.mp3')).toBe(true);

    // A sync brings a new hash for the same file: what is stored is the old recording.
    store.metadata.set('Music:a.mp3', meta('Music:a.mp3', sha('b')));
    backend.deliver.set('Music:a.mp3', sha('b'));
    expect(await library.read('Music:a.mp3')).toBeNull(); // not played from the stale copy
    await settle();
    expect(library.isAvailable('Music:a.mp3')).toBe(true); // re-downloaded
    expect(backend.started.filter((id) => id === 'Music:a.mp3')).toHaveLength(2);
    expect(await library.read('Music:a.mp3')).not.toBeNull();
  });

  it('forgets an entry whose file has vanished from disk', async () => {
    const { library, backend } = await setup();
    backend.autoFinish = true;
    library.request(['Music:a.mp3']);
    await settle();
    backend.files.delete('Music:a.mp3');
    expect(await library.read('Music:a.mp3')).toBeNull();
    expect(library.isAvailable('Music:a.mp3')).toBe(false);
  });
});

describe('OfflineLibrary storage', () => {
  it('survives a restart, and reconciles the index with what is on disk', async () => {
    const store = new MemoryStore();
    const backend = new FakeBackend();
    backend.autoFinish = true;
    const first = await setup({ store, backend });
    first.library.request(['Music:a.mp3', 'Music:b.mp3']);
    await settle();

    // While the app was closed one file was cleared from storage, and a half-finished one was left behind.
    backend.files.delete('Music:b.mp3');
    backend.files.set('Music:orphan.mp3', { bytes: new ArrayBuffer(4), sha256: sha('c') });
    const second = await setup({ store, backend });
    await settle();
    expect(second.library.isAvailable('Music:a.mp3')).toBe(true);
    expect(second.library.isAvailable('Music:b.mp3')).toBe(false);
    expect(backend.files.has('Music:orphan.mp3')).toBe(false);
  });

  it('evicts the least recently played unpinned copies to fit a budget, and never the pinned ones', async () => {
    const { library, backend } = await setup();
    backend.autoFinish = true;
    library.request(['Music:keep.mp3'], { pin: true });
    library.request(['Music:old.mp3', 'Music:mid.mp3', 'Music:new.mp3'], { pin: false });
    await settle();
    expect(library.getState().downloadedBytes).toBe(16);
    await library.read('Music:old.mp3'); // touch order: mid is now the least recently used, then new, then old
    await library.read('Music:new.mp3');
    await library.read('Music:old.mp3');

    await library.setBudgetBytes(10); // room for two 4-byte files... plus the pinned one counts too
    await settle();
    expect(library.isAvailable('Music:keep.mp3')).toBe(true);
    expect(library.isAvailable('Music:mid.mp3')).toBe(false); // least recently used goes first
    expect(library.isAvailable('Music:new.mp3')).toBe(false);
    expect(library.isAvailable('Music:old.mp3')).toBe(true);
    expect(library.getState().downloadedBytes).toBeLessThanOrEqual(10);

    await library.setBudgetBytes(1); // far too small: the pinned track still stays
    expect(library.isAvailable('Music:keep.mp3')).toBe(true);
  });

  describe('keeping what is played', () => {
    it('is off until asked, and the choice survives a restart', async () => {
      const { library, backend, store } = await setup();
      backend.autoFinish = true;
      expect(library.getState().cacheOnPlay).toBe(false);
      expect(await library.fetchForPlayback('Music:a.mp3')).toBe(false);
      expect(backend.started).toEqual([]);

      await library.setCacheOnPlay(true);
      expect(library.getState().cacheOnPlay).toBe(true);
      const restarted = await setup({ store });
      expect(restarted.library.getState().cacheOnPlay).toBe(true);
    });

    it('stores a played track once, unpinned, and shares one transfer between readers', async () => {
      const { library, backend } = await setup();
      backend.autoFinish = true;
      await library.setCacheOnPlay(true);
      const [first, second] = await Promise.all([library.fetchForPlayback('Music:a.mp3'), library.fetchForPlayback('Music:a.mp3')]);
      expect([first, second]).toEqual([true, true]);
      expect(backend.started).toEqual(['Music:a.mp3']);
      expect(library.isAvailable('Music:a.mp3')).toBe(true);
      expect(library.isPinned('Music:a.mp3')).toBe(false);
      expect(await library.fetchForPlayback('Music:a.mp3')).toBe(true); // already kept
      expect(backend.started).toHaveLength(1);
    });

    it('keeps played tracks under the limit, evicting the least recently played, but never what was asked for', async () => {
      const { library, backend } = await setup();
      backend.autoFinish = true;
      await library.setCacheOnPlay(true);
      library.request(['Music:chosen.mp3'], { pin: true });
      await settle();
      await library.setBudgetBytes(9); // two 4-byte files fit, a third pushes the oldest played out
      for (const id of ['Music:one.mp3', 'Music:two.mp3', 'Music:three.mp3']) await library.fetchForPlayback(id);
      await settle();
      expect(library.isAvailable('Music:chosen.mp3')).toBe(true);
      expect(library.isAvailable('Music:one.mp3')).toBe(false);
      expect(library.isAvailable('Music:three.mp3')).toBe(true);
    });

    it('leaves no trace when the fetch fails, so playback just streams it', async () => {
      const { library, backend } = await setup();
      await library.setCacheOnPlay(true);
      backend.failWith.set('Music:a.mp3', [new NetworkError(new Error('down'))]);
      expect(await library.fetchForPlayback('Music:a.mp3')).toBe(false);
      expect(library.getState()).toMatchObject({ paused: false, queuedCount: 0, activeCount: 0, failures: [] });
      expect(library.isAvailable('Music:a.mp3')).toBe(false);
    });

    it('does not take over a track already queued as a download', async () => {
      const { library, backend } = await setup({ concurrency: 1 });
      await library.setCacheOnPlay(true);
      library.request(['Music:first.mp3', 'Music:wanted.mp3'], { pin: true }); // first runs, wanted waits in the queue
      await settle();
      expect(await library.fetchForPlayback('Music:wanted.mp3')).toBe(false);
      backend.complete('Music:first.mp3');
    });
  });

  it('removes and clears downloads', async () => {
    const { library, backend } = await setup();
    backend.autoFinish = true;
    library.request(['Music:a.mp3', 'Music:b.mp3', 'Music:c.mp3']);
    await settle();
    await library.remove(['Music:a.mp3']);
    expect(library.isAvailable('Music:a.mp3')).toBe(false);
    expect(backend.files.has('Music:a.mp3')).toBe(false);
    await library.clear();
    expect(library.getState()).toMatchObject({ downloadedCount: 0, downloadedBytes: 0 });
    expect(backend.files.size).toBe(0);
  });

  it('notifies subscribers of every change', async () => {
    const { library, backend } = await setup();
    backend.autoFinish = true;
    const counts: number[] = [];
    const stop = library.subscribe((s) => counts.push(s.downloadedCount));
    library.request(['Music:a.mp3']);
    await settle();
    stop();
    expect(counts[counts.length - 1]).toBe(1);
    expect(vi.isMockFunction(stop)).toBe(false);
  });
});
