import type { MeDto } from '@beatseam/api';
import { API_VERSION } from '@beatseam/api';
import { base32Decode, hotp, totpStep } from '../src/auth/crypto/totp.js';

/** A controllable time source for TOTP (see CLOCK in auth.service.ts). Each advance() opens a fresh 30s window. */
export function createTestClock() {
  let nowMs = Date.now();
  return {
    now: () => nowMs,
    advance: (windows = 1) => {
      nowMs += windows * 30_000;
    },
  };
}
export type TestClock = ReturnType<typeof createTestClock>;

/** The 6-digit code an authenticator app would show for `secret` at the clock's time. */
export function totpCode(secret: string, clock: TestClock): string {
  return hotp(base32Decode(secret), totpStep(clock.now()));
}

export const PASSWORD = 'a long enough password';

/** A browser stand-in: keeps the session cookie and sends the CSRF header the API requires. */
export class TestClient {
  cookie: string | undefined;
  /** A native app's device token; sent as `Authorization: Bearer` (and no CSRF header, like an app would). */
  bearer: string | undefined;

  constructor(readonly baseUrl: string) {}

  async fetch(path: string, init: RequestInit & { json?: unknown; headers?: Record<string, string>; csrf?: boolean } = {}): Promise<Response> {
    const { json, csrf = true, headers = {}, ...rest } = init;
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...(csrf ? { 'x-beatseam-api': String(API_VERSION) } : {}),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('beatseam_session='));
    if (setCookie) this.cookie = setCookie.startsWith('beatseam_session=;') ? undefined : setCookie.split(';')[0];
    return res;
  }

  async json<T>(path: string, init?: Parameters<TestClient['fetch']>[1]): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  post<T>(path: string, json?: unknown): Promise<T> {
    return this.json<T>(path, { method: 'POST', json: json ?? {} });
  }

  /** Sets up password + TOTP for whoever is signed in (the way a person without a passkey enrolls). Returns the TOTP secret and recovery codes. */
  async enrollPasswordAndTotp(clock: TestClock): Promise<{ secret: string; recoveryCodes: string[] }> {
    await this.fetch('/api/v1/auth/password', { method: 'POST', json: { password: PASSWORD } });
    const { secret } = await this.post<{ secret: string }>('/api/v1/auth/totp/begin');
    const { recoveryCodes } = await this.post<{ recoveryCodes: string[] }>('/api/v1/auth/totp/enable', { code: totpCode(secret, clock) });
    return { secret, recoveryCodes };
  }
}

/** First sign-up -> enrolled admin, the way a fresh server is set up. */
export async function setUpAdmin(baseUrl: string, clock: TestClock, username = 'admin'): Promise<{ client: TestClient; secret: string; recoveryCodes: string[]; me: MeDto }> {
  const client = new TestClient(baseUrl);
  await client.post('/api/v1/auth/setup', { username, displayName: 'The Admin' });
  const { secret, recoveryCodes } = await client.enrollPasswordAndTotp(clock);
  return { client, secret, recoveryCodes, me: await client.json<MeDto>('/api/v1/auth/me') };
}

/** An admin creates a user, who redeems the link and enrolls with password + TOTP: returns that user's signed-in client. */
export async function setUpUser(admin: TestClient, baseUrl: string, clock: TestClock, username: string): Promise<{ client: TestClient; userId: string }> {
  const { user, invite } = await admin.post<{ user: { id: string }; invite: { inviteToken: string } }>('/api/v1/users', { username, displayName: username });
  const client = new TestClient(baseUrl);
  await client.post('/api/v1/auth/invites/redeem', { inviteToken: invite.inviteToken });
  clock.advance();
  await client.enrollPasswordAndTotp(clock);
  return { client, userId: user.id };
}
