import type { z } from 'zod';
import {
  authStatusSchema,
  deviceCodeResultSchema,
  deviceWaitResultSchema,
  meSchema,
  type AuthStatusDto,
  type DeviceCodeResultDto,
  type DeviceWaitResultDto,
  type MeDto,
} from './auth';
import {
  lastFmConnectResultSchema,
  lastFmStatusSchema,
  type LastFmConnectResultDto,
  type LastFmNowPlayingRequestDto,
  type LastFmScrobbleEntryDto,
  type LastFmStatusDto,
} from './lastfm';
import { mutationsResponseSchema, type MutationDto, type MutationsResponseDto } from './mutations';
import { API_VERSION, API_VERSION_HEADER, lyricsSchema, lyricsSourceSchema, type LyricsDto, type LyricsSaveRequestDto, type LyricsSourceDto, type Page, type TrackDto, pageSchema, trackSchema } from './schemas';
import { syncChangesResponseSchema, syncSnapshotResponseSchema, type SyncChangesResponseDto, type SyncSnapshotResponseDto } from './sync';
import { utf8Decode } from './encoding';
import { encodeTrackKey } from './trackKey';

/** The server answered with an error status. `code` is the machine-readable reason when it gave one. */
/** Long enough for a slow link, short enough that a stalled connection doesn't hold up everything behind it. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The sync position is too old or unknown: take a snapshot instead of asking for changes. */
export class ResyncRequiredError extends ApiError {
  constructor(message: string) {
    super(410, message, 'resync_required');
    this.name = 'ResyncRequiredError';
  }
}

/** The server can't be reached at all (offline, wrong address, down) - as opposed to answering with an error. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Network request failed');
    this.name = 'NetworkError';
  }
}

export interface ApiClientOptions {
  /** e.g. `https://music.example.com`. Empty means same-origin (the web app served by the server itself). */
  baseUrl: string;
  /** A native app's device token. The web app leaves this out and relies on its session cookie. */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: typeof fetch;
  /** How long a JSON request may take to get its answer before it is given up on. Default 30s. */
  requestTimeoutMs?: number;
}

export type DeviceSignInProgress =
  | { kind: 'code'; userCode: string; verificationUri: string; expiresInSeconds: number }
  | { kind: 'waiting' };

export type DeviceSignInResult = { token: string; me: MeDto } | { denied: true } | { expired: true };

/**
 * A small, typed client for the BPMix server. Shared by every app so the wire format lives in one
 * place; responses are validated against the same schemas the server is written against, so a
 * version mismatch fails loudly here instead of corrupting local data.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  // ---------------------------------------------------------------- plumbing

  /** The headers a request to the server needs (API version, and the bearer token for a native app) - for backends that perform the request themselves, e.g. a native file downloader. */
  async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.options.getToken?.();
    return { [API_VERSION_HEADER]: String(API_VERSION), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
  }

  /** Performs a request, turning "couldn't connect" and "server said no" into distinct errors. */
  private async send(method: string, path: string, init: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    // A request that never answers (a connection the OS silently stalls, e.g. while the app is in the
    // background) must not block whatever is queued behind it: give up and report it like any lost connection.
    const controller = new AbortController();
    const forward = () => controller.abort();
    init.signal?.addEventListener('abort', forward);
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: await this.authHeaders(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new NetworkError(controller.signal.aborted ? new Error('The server did not answer in time') : err);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', forward);
    }
    if (response.ok) return response;
    let body: { code?: string; message?: string | string[] } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // not JSON - fall back to the status line
    }
    const message = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? (response.statusText || `HTTP ${response.status}`));
    if (response.status === 410 && body.code === 'resync_required') throw new ResyncRequiredError(message);
    throw new ApiError(response.status, message, body.code);
  }

  private async request<S extends z.ZodType>(method: string, path: string, schema: S, init?: { body?: unknown; signal?: AbortSignal; timeoutMs?: number }): Promise<z.infer<S>> {
    const response = await this.send(method, path, init);
    return schema.parse(await response.json());
  }

  // ---------------------------------------------------------------- auth

  authStatus(): Promise<AuthStatusDto> {
    return this.request('GET', '/api/v1/auth/status', authStatusSchema);
  }

  me(): Promise<MeDto> {
    return this.request('GET', '/api/v1/auth/me', meSchema);
  }

  deviceCode(deviceName: string): Promise<DeviceCodeResultDto> {
    return this.request('POST', '/api/v1/auth/device/code', deviceCodeResultSchema, { body: { deviceName } });
  }

  /** Holds open until the user decides (or the server's wait ends with 'pending' - ask again). */
  deviceWait(deviceCode: string, signal?: AbortSignal): Promise<DeviceWaitResultDto> {
    // The server holds this open for its own wait (~25s) before answering 'pending'.
    return this.request('POST', '/api/v1/auth/device/wait', deviceWaitResultSchema, { body: { deviceCode }, signal, timeoutMs: 120_000 });
  }

  /**
   * The whole native sign-in: ask for a code, hand it to `onProgress` for display, then wait for the
   * user to approve it in a browser. The waiting is a chain of held-open requests, not a timer.
   */
  async signInWithDeviceCode(deviceName: string, onProgress: (progress: DeviceSignInProgress) => void, signal?: AbortSignal): Promise<DeviceSignInResult> {
    const grant = await this.deviceCode(deviceName);
    onProgress({ kind: 'code', userCode: grant.userCode, verificationUri: grant.verificationUri, expiresInSeconds: grant.expiresInSeconds });
    while (!signal?.aborted) {
      const result = await this.deviceWait(grant.deviceCode, signal);
      onProgress({ kind: 'waiting' });
      if (result.status === 'approved') return { token: result.token, me: result.me };
      if (result.status === 'denied') return { denied: true };
      if (result.status === 'expired') return { expired: true };
    }
    // Not DOMException: React Native's JS engine doesn't provide it everywhere.
    throw Object.assign(new Error('Sign-in cancelled'), { name: 'AbortError' });
  }

  /** A browser signing out: ends its session and clears the cookie. */
  async logout(): Promise<void> {
    await this.send('POST', '/api/v1/auth/logout', { body: {} });
  }

  /** A native app signing itself out: revokes the token it is calling with. */
  async signOutThisDevice(): Promise<void> {
    await this.send('DELETE', '/api/v1/auth/me/token');
  }

  // ---------------------------------------------------------------- last.fm (the server holds the link)

  lastFmStatus(): Promise<LastFmStatusDto> {
    return this.request('GET', '/api/v1/lastfm', lastFmStatusSchema);
  }

  /** Starts linking: returns the Last.fm page to approve BPMix on. Then call lastFmComplete(). */
  lastFmConnect(): Promise<LastFmConnectResultDto> {
    return this.request('POST', '/api/v1/lastfm/connect', lastFmConnectResultSchema, { body: {} });
  }

  /** Finishes linking after approval. Throws ApiError(409, code 'not_authorized') while the approval hasn't happened yet. */
  lastFmComplete(): Promise<LastFmStatusDto> {
    return this.request('POST', '/api/v1/lastfm/complete', lastFmStatusSchema, { body: {} });
  }

  lastFmDisconnect(): Promise<LastFmStatusDto> {
    return this.request('DELETE', '/api/v1/lastfm', lastFmStatusSchema);
  }

  async lastFmNowPlaying(track: LastFmNowPlayingRequestDto): Promise<void> {
    await this.send('POST', '/api/v1/lastfm/now-playing', { body: track });
  }

  /** Throws ApiError 422 (code 'lastfm_rejected') when Last.fm refuses them for good, 502 ('lastfm_unreachable') when it couldn't be reached - the latter is worth retrying later. */
  async lastFmScrobble(entries: LastFmScrobbleEntryDto[]): Promise<void> {
    await this.send('POST', '/api/v1/lastfm/scrobbles', { body: { entries } });
  }

  // ---------------------------------------------------------------- library, sync, mutations

  listTracks(query: { rootId?: string; q?: string; cursor?: string; limit?: number } = {}): Promise<Page<TrackDto>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const qs = params.toString();
    return this.request('GET', `/api/v1/tracks${qs ? `?${qs}` : ''}`, pageSchema(trackSchema));
  }

  /** Throws ResyncRequiredError when `since` is too old: take a snapshot instead. */
  syncChanges(since: string, limit?: number): Promise<SyncChangesResponseDto> {
    return this.request('GET', `/api/v1/sync/changes?since=${encodeURIComponent(since)}${limit ? `&limit=${limit}` : ''}`, syncChangesResponseSchema);
  }

  syncSnapshot(after?: string, limit?: number): Promise<SyncSnapshotResponseDto> {
    const params = new URLSearchParams();
    if (after) params.set('after', after);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return this.request('GET', `/api/v1/sync/snapshot${qs ? `?${qs}` : ''}`, syncSnapshotResponseSchema);
  }

  mutations(mutations: MutationDto[]): Promise<MutationsResponseDto> {
    return this.request('POST', '/api/v1/mutations', mutationsResponseSchema, { body: { mutations } });
  }

  // ---------------------------------------------------------------- files

  /** Address of a track's audio. Fetch it with `fetchBytes`/`fetchRange` so the auth header is sent. */
  streamPath(trackKey: string): string {
    return `/api/v1/tracks/${trackKey}/stream`;
  }

  /** The track's lyrics, or null if it has none. */
  async lyrics(trackKey: string, signal?: AbortSignal): Promise<LyricsDto | null> {
    try {
      return await this.request('GET', `/api/v1/tracks/${trackKey}/lyrics`, lyricsSchema, { signal });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Admin only. The file assigned to the track's lyrics and every file it could be assigned. */
  lyricsSource(trackKey: string): Promise<LyricsSourceDto> {
    return this.request('GET', `/api/v1/tracks/${trackKey}/lyrics/source`, lyricsSourceSchema);
  }

  /** Admin only. Links the track to a lyrics file (or, with null, to none). */
  async assignLyrics(trackKey: string, lrcFileId: string | null): Promise<void> {
    await this.send('PUT', `/api/v1/tracks/${trackKey}/lyrics/assignment`, { body: { lrcFileId } });
  }

  /** Admin only. Writes the lines back to the track's assigned .lrc file. Throws ApiError 409 (code 'lyrics_read_only') when the server's lyrics folder can't be written to. */
  async saveLyrics(trackKey: string, lines: LyricsSaveRequestDto['lines']): Promise<void> {
    await this.send('PUT', `/api/v1/tracks/${trackKey}/lyrics`, { body: { lines } });
  }

  coverPath(trackKey: string): string {
    return `/api/v1/tracks/${trackKey}/cover`;
  }

  /** For a raw file id (`Root:path/to/file.mp3`) rather than a key. */
  streamPathForFileId(fileId: string): string {
    return this.streamPath(encodeTrackKey(fileId));
  }

  /** Full URL, for the rare place that needs one (e.g. handing to a native player). Auth still has to be supplied separately. */
  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** The bytes behind a path (audio, cover art, ...). */
  async fetchBytes(path: string, init: { range?: { start: number; end: number }; signal?: AbortSignal } = {}): Promise<ArrayBuffer> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      headers: await this.authHeaders(init.range ? { range: `bytes=${init.range.start}-${init.range.end}` } : {}),
      signal: init.signal,
    }).catch((err: unknown) => {
      if (init.signal?.aborted) throw err;
      throw new NetworkError(err);
    });
    if (!response.ok) throw new ApiError(response.status, response.statusText || `HTTP ${response.status}`);
    return response.arrayBuffer();
  }

  /** Like fetchBytes, but also says what the server called the file (for cover art: image/webp, ...). */
  async fetchFile(path: string, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, { headers: await this.authHeaders(), signal }).catch((err: unknown) => {
      if (signal?.aborted) throw err;
      throw new NetworkError(err);
    });
    if (!response.ok) throw new ApiError(response.status, response.statusText || `HTTP ${response.status}`);
    return { bytes: await response.arrayBuffer(), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** The text of a file at a path (e.g. lyrics). */
  async fetchText(path: string, signal?: AbortSignal): Promise<string> {
    return utf8Decode(new Uint8Array(await this.fetchBytes(path, { signal })));
  }
}
