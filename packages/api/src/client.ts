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
import { mutationsResponseSchema, type MutationDto, type MutationsResponseDto } from './mutations';
import { API_VERSION, API_VERSION_HEADER, type Page, type TrackDto, pageSchema, trackSchema } from './schemas';
import { syncChangesResponseSchema, syncSnapshotResponseSchema, type SyncChangesResponseDto, type SyncSnapshotResponseDto } from './sync';
import { encodeTrackKey } from './trackKey';

/** The server answered with an error status. `code` is the machine-readable reason when it gave one. */
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

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.options.getToken?.();
    return { [API_VERSION_HEADER]: String(API_VERSION), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
  }

  /** Performs a request, turning "couldn't connect" and "server said no" into distinct errors. */
  private async send(method: string, path: string, init: { body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: await this.headers(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new NetworkError(err);
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

  private async request<S extends z.ZodType>(method: string, path: string, schema: S, init?: { body?: unknown; signal?: AbortSignal }): Promise<z.infer<S>> {
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
    return this.request('POST', '/api/v1/auth/device/wait', deviceWaitResultSchema, { body: { deviceCode }, signal });
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
    throw new DOMException('Sign-in cancelled', 'AbortError');
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
      headers: await this.headers(init.range ? { range: `bytes=${init.range.start}-${init.range.end}` } : {}),
      signal: init.signal,
    }).catch((err: unknown) => {
      if (init.signal?.aborted) throw err;
      throw new NetworkError(err);
    });
    if (!response.ok) throw new ApiError(response.status, response.statusText || `HTTP ${response.status}`);
    return response.arrayBuffer();
  }

  /** The text of a file at a path (e.g. lyrics). */
  async fetchText(path: string, signal?: AbortSignal): Promise<string> {
    return new TextDecoder().decode(await this.fetchBytes(path, { signal }));
  }
}
