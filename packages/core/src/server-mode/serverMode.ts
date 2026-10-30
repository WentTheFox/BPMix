import {
  ApiClient,
  ApiError,
  decodeTrackKey,
  encodeTrackKey,
  NetworkError,
  ResyncRequiredError,
  type DeviceSignInProgress,
  type DeviceSignInResult,
  type LastFmStatusDto,
  type LyricsDto,
  type MeDto,
  type SyncChangeDto,
} from '@bpmix/api';
import type { GrantedRoot } from '../file-access/types';
import type { LibraryStore, PlaybackState } from '../library-store/types';
import { errorMessage } from '../errorMessage';
import { applyChange, USER_PLAYLIST_ID_PREFIX, type ApplyContext } from './applySync';
import { DEVICE_PLAYBACK_KEY, listDevicePlayback, playbackPayload, type RemotePlayback } from './devicePlayback';
import { MutationQueue } from './mutationQueue';
import { randomId } from './randomId';
import { SERVER_SCROBBLE_QUEUE_KEY } from './serverLastFm';

const CONFIG_KEY = 'serverMode.config';
const CURSOR_KEY = 'serverMode.cursor';
const ROOTS_KEY = 'serverMode.roots';
const SYNCED_AT_KEY = 'serverMode.syncedAtMs';
const DEVICE_ID_KEY = 'serverMode.deviceId';
/** This device's playback state goes to the server at most this often while it's just the position moving. */
const PLAYBACK_PUSH_INTERVAL_MS = 20_000;
const LASTFM_STATUS_KEY = 'serverMode.lastFmStatus';
const LYRICS_CACHE_PREFIX = 'serverMode.lyrics:';
const LYRICS_INDEX_KEY = 'serverMode.lyricsIndex';
const MAX_CACHED_LYRICS = 2000;
const PAGE_SIZE = 500;

interface StoredConfig {
  /** Where the server is, e.g. https://music.example.com. Empty for the web app served by the server itself. */
  url: string;
  /** A native app's device token. Null on the web, which relies on its session cookie. */
  token: string | null;
  userName: string | null;
  /** The token lives in the platform's secret storage (see ServerModeDeps.secretStore), not in this record. */
  tokenInSecretStore?: boolean;
}

/** Hardware-backed storage for the device token (Android Keystore), so a copy of the app's data doesn't carry a working sign-in. */
export interface SecretStore {
  get(): Promise<string | null>;
  /** Null removes it. */
  set(value: string | null): Promise<void>;
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
  /** Where the device token is kept. Without one it is stored with the rest of the settings. */
  secretStore?: SecretStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** The web app served by the server itself: same address, cookie instead of a token. */
  sameOrigin?: boolean;
}

/** Normalises what a person typed into an address: adds a scheme if missing, drops trailing slashes and any path. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter the server address');
  // No scheme typed: https, except for a server on the local network, where plain http is what people run.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${hostIsPrivate(trimmed) ? 'http' : 'https'}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like an address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The address must start with http:// or https://');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new Error('Plain http:// is only allowed for servers on your own network (a local address); use https:// for anything on the internet');
  }
  return url.origin;
}

function hostIsPrivate(typed: string): boolean {
  try {
    return isPrivateHost(new URL(`http://${typed}`).hostname);
  } catch {
    return false; // the real parse below reports what is wrong with it
  }
}

/**
 * Whether a host name is on a private network or the device itself, where unencrypted http is an acceptable
 * trade for not having to set up a certificate: loopback, RFC 1918, link-local, CGNAT (Tailscale), IPv6
 * local ranges, single-label names and the usual home-network suffixes. Anything else could be crossing the
 * internet, where the device token would be readable by anyone on the path.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  return !host.includes('.') || /\.(local|lan|home\.arpa|internal|localhost)$/.test(host);
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
  /** Names this device to the server and to the other devices' "continue" lists; made once and kept. */
  private deviceId = '';
  private lastPush: { trackFileId: string | null; atMs: number } = { trackFileId: null, atMs: 0 };
  private pendingPush: PlaybackState | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
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
    const [rawConfig, rawRoots, rawSynced, rawDeviceId] = await Promise.all([store.getSetting(CONFIG_KEY), store.getSetting(ROOTS_KEY), store.getSetting(SYNCED_AT_KEY), store.getSetting(DEVICE_ID_KEY)]);
    this.deviceId = rawDeviceId || randomId();
    if (!rawDeviceId) await store.putSetting(DEVICE_ID_KEY, this.deviceId);
    if (rawConfig) {
      try {
        this.config = await this.revealToken(JSON.parse(rawConfig) as StoredConfig);
        if (this.config) this.api = this.makeApi(this.config);
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

  /**
   * Fills in the token from secret storage. A token still sitting in the settings from before there was
   * a secret store is moved there. Returns null (signed out) if the secret is gone, e.g. the Keystore
   * key was wiped: a stored sign-in without its token can't do anything.
   */
  private async revealToken(stored: StoredConfig): Promise<StoredConfig | null> {
    const secrets = this.deps.secretStore;
    if (!secrets) return stored;
    if (stored.tokenInSecretStore) {
      const token = await secrets.get();
      return token ? { ...stored, token } : null;
    }
    if (stored.token) {
      await secrets.set(stored.token);
      await this.deps.store.putSetting(CONFIG_KEY, JSON.stringify({ ...stored, token: null, tokenInSecretStore: true }));
    }
    return stored;
  }

  private async saveConfig(config: StoredConfig | null): Promise<void> {
    this.config = config;
    this.api = config ? this.makeApi(config) : null;
    const secrets = this.deps.secretStore;
    let persisted = config;
    if (secrets) {
      // The secret goes in first, so a record never points at a token that was not written.
      await secrets.set(config?.token ?? null);
      if (config?.token) persisted = { ...config, token: null, tokenInSecretStore: true };
    }
    // putSetting has no delete; an empty value is read back as "none" by loadSaved's JSON.parse guard.
    await this.deps.store.putSetting(CONFIG_KEY, persisted ? JSON.stringify(persisted) : '');
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

  /**
   * Tells the server what this device is playing, so the person's other devices can offer to continue it.
   * A new track goes out at once; while the same track just advances, at most every few seconds' worth,
   * with a single trailing send (no polling: it fires once, after the last change).
   */
  pushPlaybackState(state: PlaybackState): void {
    if (!this.isActive() || !state.playlistId || !state.currentTrackFileId) return;
    this.pendingPush = state;
    const since = this.now() - this.lastPush.atMs;
    if (state.currentTrackFileId !== this.lastPush.trackFileId || since >= PLAYBACK_PUSH_INTERVAL_MS) {
      this.sendPendingPlayback();
    } else if (!this.pushTimer) {
      this.pushTimer = setTimeout(() => this.sendPendingPlayback(), PLAYBACK_PUSH_INTERVAL_MS - since);
    }
  }

  private sendPendingPlayback(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    const state = this.pendingPush;
    this.pendingPush = null;
    if (!state || !this.isActive()) return;
    this.lastPush = { trackFileId: state.currentTrackFileId, atMs: this.now() };
    void this.mutations.enqueue({ type: 'playbackState.set', deviceId: this.deviceId, state: playbackPayload(state, this.deps.deviceName(), this.now()) });
  }

  /** What the person's other devices were playing, as of the last sync - most recent first. No network. */
  otherDevicesPlayback(): Promise<RemotePlayback[]> {
    return listDevicePlayback(this.deps.store, this.now());
  }

  /**
   * A track's lyrics from the server. Each answer (including "none") is kept locally, so lyrics keep working
   * offline for everything played before; when the server can't be reached the kept copy is used.
   */
  async lyricsFor(fileId: string): Promise<LyricsDto | null> {
    const key = `${LYRICS_CACHE_PREFIX}${fileId}`;
    const api = this.getApi();
    if (api) {
      try {
        const lyrics = await api.lyrics(encodeTrackKey(fileId));
        await this.deps.store.putSetting(key, lyrics ? JSON.stringify(lyrics) : '-');
        await this.rememberCachedLyrics(fileId);
        return lyrics;
      } catch {
        // Offline or unwell: fall back to what was kept.
      }
    }
    const kept = await this.deps.store.getSetting(key);
    if (!kept || kept === '-') return null;
    try {
      return JSON.parse(kept) as LyricsDto;
    } catch {
      return null;
    }
  }

  /**
   * Where the user's Last.fm link stands, from the server. The last answer is kept, so scrobbling keeps
   * going (and queueing) while the server can't be reached; null when it has never been fetched.
   */
  async lastFmStatus(): Promise<LastFmStatusDto | null> {
    const api = this.getApi();
    if (api) {
      try {
        const status = await api.lastFmStatus();
        await this.cacheLastFmStatus(status);
        return status;
      } catch {
        // Offline or unwell: fall back to the kept answer.
      }
    }
    const kept = await this.deps.store.getSetting(LASTFM_STATUS_KEY);
    if (!kept) return null;
    try {
      return JSON.parse(kept) as LastFmStatusDto;
    } catch {
      return null;
    }
  }

  cacheLastFmStatus(status: LastFmStatusDto): Promise<void> {
    return this.deps.store.putSetting(LASTFM_STATUS_KEY, JSON.stringify(status));
  }

  /** Remembers which tracks have kept lyrics (the store can't list settings by prefix), newest last, capped. */
  private async rememberCachedLyrics(fileId: string): Promise<void> {
    const index = await this.cachedLyricsIndex();
    const next = [...index.filter((id) => id !== fileId), fileId];
    for (const evicted of next.splice(0, Math.max(0, next.length - MAX_CACHED_LYRICS))) await this.deps.store.putSetting(`${LYRICS_CACHE_PREFIX}${evicted}`, '');
    await this.deps.store.putSetting(LYRICS_INDEX_KEY, JSON.stringify(next));
  }

  private async cachedLyricsIndex(): Promise<string[]> {
    try {
      const parsed: unknown = JSON.parse((await this.deps.store.getSetting(LYRICS_INDEX_KEY)) || '[]');
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
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
    // One account's lyrics aren't shown to the next.
    for (const fileId of await this.cachedLyricsIndex()) await store.putSetting(`${LYRICS_CACHE_PREFIX}${fileId}`, '');
    await store.putSetting(LYRICS_INDEX_KEY, '');
    await store.putSetting(SERVER_SCROBBLE_QUEUE_KEY, '');
    await store.putSetting(DEVICE_PLAYBACK_KEY, '');
    this.pendingPush = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.lastPush = { trackFileId: null, atMs: 0 };
    await store.putSetting(LASTFM_STATUS_KEY, '');
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
    return { store: this.deps.store, defaultRootId: () => this.cachedRoots[0]?.id ?? null, now: this.now, deviceId: this.deviceId };
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
