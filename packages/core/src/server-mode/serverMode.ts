import {
  ApiClient,
  ApiError,
  decodeTrackKey,
  NetworkError,
  ResyncRequiredError,
  type DeviceSignInProgress,
  type DeviceSignInResult,
  type MeDto,
  type SyncChangeDto,
} from '@bpmix/api';
import type { GrantedRoot } from '../file-access/types';
import type { LibraryStore } from '../library-store/types';
import { errorMessage } from '../errorMessage';
import { applyChange, USER_PLAYLIST_ID_PREFIX, type ApplyContext } from './applySync';
import { MutationQueue } from './mutationQueue';

const CONFIG_KEY = 'serverMode.config';
const CURSOR_KEY = 'serverMode.cursor';
const ROOTS_KEY = 'serverMode.roots';
const SYNCED_AT_KEY = 'serverMode.syncedAtMs';
const PAGE_SIZE = 500;

interface StoredConfig {
  /** Where the server is, e.g. https://music.example.com. Empty for the web app served by the server itself. */
  url: string;
  /** A native app's device token. Null on the web, which relies on its session cookie. */
  token: string | null;
  userName: string | null;
}

export interface ServerStatus {
  /** There's a signed-in server this app takes its library from. */
  active: boolean;
  url: string;
  userName: string | null;
  lastSyncedAtMs: number | null;
  syncing: boolean;
  /** The last sync could not reach the server; the cached library is being shown. */
  offline: boolean;
  /** Why the last attempt failed, if it did for a reason other than being offline. */
  error: string | null;
}

export interface SyncOutcome {
  kind: 'snapshot' | 'delta' | 'offline' | 'signedOut' | 'failed' | 'inactive';
  /** The local library was modified. */
  changed: boolean;
}

export interface ServerModeDeps {
  store: LibraryStore;
  /** Used to name this device when it asks to be signed in ("Pixel 8", "Windows PC"). */
  deviceName: () => string;
  fetch?: typeof fetch;
  now?: () => number;
  /** The web app served by the server itself: same address, cookie instead of a token. */
  sameOrigin?: boolean;
}

/** Normalises what a person typed into an address: adds a scheme if missing, drops trailing slashes and any path. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter the server address');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like an address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The address must start with http:// or https://');
  return url.origin;
}

/**
 * Takes the app's library from a BPMix server instead of scanning folders: holds the sign-in, checks
 * in with the server (a snapshot the first time, then what changed) and writes what it learns into
 * the same LibraryStore the local scan fills, so everything that reads the library keeps working.
 * Offline is a normal state: the last synced library stays, and the next check-in catches up.
 */
export class ServerMode {
  /** Resolves once the saved sign-in has been read from local storage (fast, never the network). */
  readonly ready: Promise<void>;
  /** Changes made here that the server hasn't seen yet; flushed at the start of every check-in. */
  readonly mutations: MutationQueue;

  private config: StoredConfig | null = null;
  private cachedRoots: GrantedRoot[] = [];
  private status: ServerStatus = { active: false, url: '', userName: null, lastSyncedAtMs: null, syncing: false, offline: false, error: null };
  private api: ApiClient | null = null;
  private current: Promise<SyncOutcome> | null = null;
  private readonly listeners = new Set<(status: ServerStatus) => void>();
  private readonly now: () => number;

  constructor(private readonly deps: ServerModeDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.mutations = new MutationQueue(deps.store, () => this.getApi());
    this.ready = this.loadSaved();
  }

  // ---------------------------------------------------------------- state

  isActive(): boolean {
    return this.status.active;
  }

  getStatus(): ServerStatus {
    return this.status;
  }

  /** Subscribe to status changes; returns the unsubscribe function. */
  subscribe(listener: (status: ServerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True for the web app served by the server itself: sign-in is the browser session (the account pages), not a device code. */
  get usesBrowserSession(): boolean {
    return this.deps.sameOrigin === true;
  }

  /** The server's library roots as last synced - no network. */
  roots(): GrantedRoot[] {
    return this.cachedRoots;
  }

  getApi(): ApiClient | null {
    return this.status.active ? this.api : null;
  }

  private setStatus(patch: Partial<ServerStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  private makeApi(config: StoredConfig): ApiClient {
    return new ApiClient({ baseUrl: config.url, getToken: () => this.config?.token ?? null, fetch: this.deps.fetch });
  }

  private async loadSaved(): Promise<void> {
    const { store } = this.deps;
    const [rawConfig, rawRoots, rawSynced] = await Promise.all([store.getSetting(CONFIG_KEY), store.getSetting(ROOTS_KEY), store.getSetting(SYNCED_AT_KEY)]);
    if (rawConfig) {
      try {
        this.config = JSON.parse(rawConfig) as StoredConfig;
        this.api = this.makeApi(this.config);
      } catch {
        this.config = null; // unreadable: treat as signed out rather than crash on startup
      }
    }
    if (rawRoots) {
      try {
        this.cachedRoots = JSON.parse(rawRoots) as GrantedRoot[];
      } catch {
        this.cachedRoots = [];
      }
    }
    this.setStatus({
      active: this.config !== null,
      url: this.config?.url ?? '',
      userName: this.config?.userName ?? null,
      lastSyncedAtMs: rawSynced ? Number(rawSynced) : null,
    });
  }

  private async saveConfig(config: StoredConfig | null): Promise<void> {
    this.config = config;
    this.api = config ? this.makeApi(config) : null;
    // putSetting has no delete; an empty value is read back as "none" by loadSaved's JSON.parse guard.
    await this.deps.store.putSetting(CONFIG_KEY, config ? JSON.stringify(config) : '');
    this.setStatus({ active: config !== null, url: config?.url ?? '', userName: config?.userName ?? null });
  }

  // ---------------------------------------------------------------- signing in and out

  /**
   * Native sign-in: ask the server for a code, let the caller show it, and wait for the person to
   * approve it in a browser. On approval the token is saved and the app switches to server mode (the
   * caller then calls sync()).
   */
  async signInWithDeviceCode(address: string, onProgress: (progress: DeviceSignInProgress) => void, signal?: AbortSignal): Promise<DeviceSignInResult> {
    const url = normalizeServerUrl(address);
    const api = new ApiClient({ baseUrl: url, fetch: this.deps.fetch });
    const result = await api.signInWithDeviceCode(this.deps.deviceName(), onProgress, signal);
    if ('token' in result) {
      await this.resetLocalCopy();
      await this.saveConfig({ url, token: result.token, userName: result.me.displayName });
      this.setStatus({ offline: false, error: null });
    }
    return result;
  }

  /** The web app, served by the server itself: nothing to type, just whether the session cookie is signed in. */
  async connectSameOrigin(): Promise<boolean> {
    await this.ready;
    const api = new ApiClient({ baseUrl: '', fetch: this.deps.fetch });
    let me: MeDto;
    try {
      me = await api.me();
    } catch {
      return false;
    }
    if (!me.enrolled) return false;
    if (this.config?.url !== '' || this.config?.userName !== me.displayName) {
      await this.resetLocalCopy();
      await this.saveConfig({ url: '', token: null, userName: me.displayName });
    }
    return true;
  }

  /** Signs this device out (revoking its token on the server when reachable) and drops the synced library. */
  async signOut(): Promise<void> {
    // Cut the sign-in off server-side too, if the server can be reached (the session for a browser, the
    // token for an app); signing out must work offline regardless.
    const end = this.config?.token === null ? this.api?.logout() : this.api?.signOutThisDevice();
    await end?.catch(() => undefined);
    await this.saveConfig(null);
    await this.resetLocalCopy();
    this.setStatus({ lastSyncedAtMs: null, offline: false, error: null });
  }

  /** Clears everything learned from a server, so a different server or user can't see the last one's library. */
  private async resetLocalCopy(): Promise<void> {
    const { store } = this.deps;
    for (const root of this.cachedRoots) {
      for (const track of await store.listTracks(root.id)) await store.deleteTrack(track.fileId);
      for (const playlist of await store.listPlaylists(root.id)) await store.deletePlaylist(playlist.id);
    }
    this.cachedRoots = [];
    // Changes queued under one account must never be sent to another.
    await this.mutations.clear();
    await Promise.all([store.putSetting(CURSOR_KEY, ''), store.putSetting(ROOTS_KEY, ''), store.putSetting(SYNCED_AT_KEY, '')]);
  }

  // ---------------------------------------------------------------- the check-in

  /** Checks in with the server. Joins a check-in already running. Never rejects: failures are in the outcome and the status. */
  sync(): Promise<SyncOutcome> {
    if (this.current) return this.current;
    const run = this.runSync().finally(() => {
      this.current = null;
      this.setStatus({ syncing: false });
    });
    this.current = run;
    return run;
  }

  private async runSync(): Promise<SyncOutcome> {
    await this.ready;
    const api = this.getApi();
    if (!api) return { kind: 'inactive', changed: false };
    this.setStatus({ syncing: true, error: null });
    try {
      // Our own changes go first, so the version of them the server hands back is what we then pull.
      await this.mutations.flush();
      const cursor = (await this.deps.store.getSetting(CURSOR_KEY)) || null;
      let outcome: SyncOutcome;
      if (cursor === null) {
        outcome = await this.snapshot(api);
      } else {
        try {
          outcome = await this.deltas(api, cursor);
        } catch (err) {
          if (!(err instanceof ResyncRequiredError)) throw err;
          outcome = await this.snapshot(api);
        }
      }
      const syncedAt = this.now();
      await this.deps.store.putSetting(SYNCED_AT_KEY, String(syncedAt));
      this.setStatus({ lastSyncedAtMs: syncedAt, offline: false });
      return outcome;
    } catch (err) {
      if (err instanceof NetworkError) {
        this.setStatus({ offline: true });
        return { kind: 'offline', changed: false };
      }
      if (err instanceof ApiError && err.status === 401) {
        // Revoked or expired: stop pretending, but keep the library visible until the person signs in again.
        await this.saveConfig(null);
        this.setStatus({ error: 'You were signed out by the server. Sign in again to keep syncing.' });
        return { kind: 'signedOut', changed: false };
      }
      this.setStatus({ error: errorMessage(err) });
      return { kind: 'failed', changed: false };
    }
  }

  private context(): ApplyContext {
    return { store: this.deps.store, defaultRootId: () => this.cachedRoots[0]?.id ?? null, now: this.now };
  }

  private async setRoots(roots: { id: string; displayName: string; kind: 'library' | 'lyrics' }[]): Promise<void> {
    // Lyrics-only roots are not music libraries (and lyrics aren't served to the app yet).
    this.cachedRoots = roots.filter((r) => r.kind === 'library').map((r): GrantedRoot => ({ id: r.id, displayName: r.displayName, kind: 'library', removable: false }));
    await this.deps.store.putSetting(ROOTS_KEY, JSON.stringify(this.cachedRoots));
  }

  /** The first sync, or after the server said our place in its history is gone: take everything, then drop what no longer exists. */
  private async snapshot(api: ApiClient): Promise<SyncOutcome> {
    const { store } = this.deps;
    const seenTracks = new Set<string>();
    const seenPlaylists = new Set<string>();
    let after: string | undefined;
    let startCursor: string | undefined;
    do {
      const page = await api.syncSnapshot(after, PAGE_SIZE);
      if (startCursor === undefined) {
        startCursor = page.cursor;
        await this.setRoots(page.roots);
      }
      for (const entity of page.entities) {
        await applyChange(this.context(), entity);
        noteSeen(entity, seenTracks, seenPlaylists);
      }
      after = page.next ?? undefined;
    } while (after);

    const rootIds = new Set(this.cachedRoots.map((r) => r.id));
    for (const track of await store.listAllTracks()) {
      if (rootIds.has(track.rootId) && !seenTracks.has(track.fileId)) await store.deleteTrack(track.fileId);
    }
    for (const playlist of await store.listAllPlaylists()) {
      if (rootIds.has(playlist.rootId) && !seenPlaylists.has(playlist.id)) await store.deletePlaylist(playlist.id);
    }
    await store.putSetting(CURSOR_KEY, startCursor ?? '0');
    return { kind: 'snapshot', changed: true };
  }

  private async countsAgree(totals: { tracks: number; playlists: number }): Promise<boolean> {
    const { store } = this.deps;
    const rootIds = new Set(this.cachedRoots.map((r) => r.id));
    const tracks = (await store.listAllTracks()).filter((t) => rootIds.has(t.rootId)).length;
    // The user's own playlists live in the same store but are not part of the server's shared-playlist total.
    const playlists = (await store.listAllPlaylists()).filter((p) => rootIds.has(p.rootId) && !p.id.startsWith(USER_PLAYLIST_ID_PREFIX)).length;
    return tracks === totals.tracks && playlists === totals.playlists;
  }

  private async deltas(api: ApiClient, since: string): Promise<SyncOutcome> {
    let cursor = since;
    let changed = false;
    for (;;) {
      const page = await api.syncChanges(cursor, PAGE_SIZE);
      await this.setRoots(page.roots);
      for (const change of page.changes) {
        if (await applyChange(this.context(), change)) changed = true;
      }
      cursor = page.cursor;
      // Saved page by page, so an interrupted check-in resumes instead of starting over.
      await this.deps.store.putSetting(CURSOR_KEY, cursor);
      if (!page.hasMore) {
        // A change feed can't put back what this device lost (a bug, cleared storage, a crash mid-write).
        // If the counts no longer agree with the server's, start over from a snapshot.
        if (!(await this.countsAgree(page.totals))) return this.snapshot(api);
        return { kind: 'delta', changed };
      }
    }
  }
}

function noteSeen(entity: SyncChangeDto, tracks: Set<string>, playlists: Set<string>): void {
  try {
    if (entity.entity === 'track' && entity.track) tracks.add(decodeTrackKey(entity.id));
    else if (entity.entity === 'playlist' && entity.playlist) playlists.add(decodeTrackKey(entity.id));
    else if (entity.entity === 'userPlaylist' && entity.userPlaylist) playlists.add(`${USER_PLAYLIST_ID_PREFIX}${entity.id}`);
  } catch {
    // an undecodable id was skipped by applyChange too
  }
}
