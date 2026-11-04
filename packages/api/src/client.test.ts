import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, ApiVersionError } from './client';
import { API_VERSION, API_VERSION_HEADER, API_VERSIONS_HEADER } from './schemas';

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const clientFor = (respond: () => Response) => new ApiClient({ baseUrl: 'https://music.example.com', fetch: (async () => respond()) as typeof fetch });
const status = { setupRequired: false, setupTokenRequired: false };

describe('ApiClient version check', () => {
  it('sends the version it speaks on every request', async () => {
    let sent: Headers | undefined;
    const api = new ApiClient({ baseUrl: 'https://x', fetch: (async (_url: unknown, init?: RequestInit) => { sent = new Headers(init?.headers); return answer(200, status); }) as typeof fetch });
    await api.authStatus();
    expect(sent?.get(API_VERSION_HEADER)).toBe(String(API_VERSION));
  });

  it('works with a server that advertises its version, and with an older one that does not (version 1 only)', async () => {
    await expect(clientFor(() => answer(200, status, { [API_VERSIONS_HEADER]: String(API_VERSION) })).authStatus()).resolves.toEqual(status);
    if (API_VERSION === 1) await expect(clientFor(() => answer(200, status)).authStatus()).resolves.toEqual(status);
  });

  it('refuses a server that has moved past the app, telling the person to update the app', async () => {
    const err = await clientFor(() => answer(200, status, { [API_VERSIONS_HEADER]: String(API_VERSION + 1) })).authStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiVersionError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 426, code: 'api_version_unsupported', problem: 'app_too_old' });
    expect((err as Error).message).toMatch(/newer version of the app/);
  });

  it('reports the mismatch ahead of the error the server also sent (the 401 here would be meaningless to an app that cannot read the reply)', async () => {
    const err = await clientFor(() => answer(401, { message: 'Sign in required' }, { [API_VERSIONS_HEADER]: String(API_VERSION + 1) })).authStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiVersionError);
  });

  it('also checks downloads of bytes and files', async () => {
    const wrong = () => new Response('x', { status: 200, headers: { [API_VERSIONS_HEADER]: String(API_VERSION + 1) } });
    await expect(clientFor(wrong).fetchBytes('/api/v1/tracks/a/audio')).rejects.toBeInstanceOf(ApiVersionError);
    await expect(clientFor(wrong).fetchFile('/api/v1/tracks/a/cover')).rejects.toBeInstanceOf(ApiVersionError);
  });
});
