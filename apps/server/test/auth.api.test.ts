import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AuthStatusDto, CreateUserResultDto, LoginResultDto, MeDto, SessionSummaryDto, UserSummaryDto } from '@bpmix/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { AppModule } from '../src/app.module.js';
import { mountLegacyRoutes } from '../src/legacy.js';
import { mountWebApp } from '../src/web.js';
import { CLOCK } from '../src/auth/auth.service.js';
import { hashPassword } from '../src/auth/crypto/password.js';
import { DatabaseService } from '../src/db/database.module.js';
import { resetDatabase } from './scanStack.js';
import { createTestClock, PASSWORD, setUpAdmin, TestClient, totpCode, type TestClock } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const clock: TestClock = createTestClock();
let app: INestApplication;
let url: string;
let base: string;
let prisma: DatabaseService['prisma'];

async function startApp(env: Record<string, string> = {}, options: { legacy?: boolean } = {}): Promise<INestApplication> {
  for (const key of ['BPMIX_SETUP_TOKEN', 'BPMIX_ORIGIN']) delete process.env[key];
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BPMIX_LIBRARY_ROOT: base, BPMIX_SCAN_ON_START: 'false', BPMIX_DATA_DIR: path.join(base, 'data'), BPMIX_AUTH_RATE_LIMIT: '1000', ...env });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock.now).compile();
  const nest = moduleRef.createNestApplication();
  if (options.legacy) mountLegacyRoutes(nest, { libraryRoot: base, lyricsRootIds: new Set() });
  await nest.init();
  await nest.listen(0);
  return nest;
}

const urlOf = async (nest: INestApplication) => (await nest.getUrl()).replace('[::1]', 'localhost');

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-auth-'));
  app = await startApp();
  url = await urlOf(app);
  prisma = app.get(DatabaseService).prisma;
}, 60_000);

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.advance(); // a fresh TOTP window per test
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const anonymous = () => new TestClient(url);

describe('first sign-up and the closed door', () => {
  it('is open only until the first account exists, and everything else needs a sign-in', async () => {
    const guest = anonymous();
    expect(await guest.json<AuthStatusDto>('/api/v1/auth/status')).toEqual({ setupRequired: true, setupTokenRequired: false });
    expect((await guest.fetch('/api/v1/tracks')).status).toBe(401);
    expect((await guest.fetch('/api/v1/scan')).status).toBe(401);
    expect((await guest.fetch('/api/v1/health')).status).toBe(200);
  });

  it('makes the first sign-up an admin who must enroll a way to sign in again before using anything', async () => {
    const client = anonymous();
    const me = await client.post<MeDto>('/api/v1/auth/setup', { username: 'Alice', displayName: 'Alice A' });
    expect(me).toMatchObject({ username: 'alice', role: 'ADMIN', enrolled: false, via: 'session' });

    const blocked = await client.fetch('/api/v1/tracks');
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'enrollment_required' });

    const { recoveryCodes } = await client.enrollPasswordAndTotp(clock);
    expect(recoveryCodes).toHaveLength(10);
    expect(await client.json<MeDto>('/api/v1/auth/me')).toMatchObject({ enrolled: true, hasPassword: true, totpEnabled: true, recoveryCodesRemaining: 10 });
    expect((await client.fetch('/api/v1/tracks')).status).toBe(200);
    expect(await anonymous().json<AuthStatusDto>('/api/v1/auth/status')).toMatchObject({ setupRequired: false });
  });

  it('refuses any further open sign-up', async () => {
    await setUpAdmin(url, clock);
    const res = await anonymous().fetch('/api/v1/auth/setup', { method: 'POST', json: { username: 'mallory', displayName: 'Mallory' } });
    expect(res.status).toBe(403);
    expect(await prisma.user.count()).toBe(1);
  });

  it('holds an unfinished first sign-up for a grace period, then lets the next attempt replace it so the server cannot be locked out', async () => {
    await anonymous().post('/api/v1/auth/setup', { username: 'abandoned', displayName: 'Gone' });
    // Still within the grace period: somebody else may not displace them.
    expect((await anonymous().fetch('/api/v1/auth/setup', { method: 'POST', json: { username: 'impatient', displayName: 'I' } })).status).toBe(403);
    expect(await prisma.user.findMany({ select: { username: true } })).toEqual([{ username: 'abandoned' }]);

    await prisma.user.updateMany({ data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    const client = anonymous();
    await client.post('/api/v1/auth/setup', { username: 'second', displayName: 'Second' });
    expect(await prisma.user.findMany({ select: { username: true } })).toEqual([{ username: 'second' }]);
  });

  it('survives simultaneous first sign-ups with exactly one winner', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((n) => anonymous().fetch('/api/v1/auth/setup', { method: 'POST', json: { username: `user-${n}`, displayName: n } })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it('requires BPMIX_SETUP_TOKEN for the first sign-up when one is configured', async () => {
    const guarded = await startApp({ BPMIX_SETUP_TOKEN: 'let-me-in' });
    try {
      const guardedUrl = await urlOf(guarded);
      const client = new TestClient(guardedUrl);
      expect(await client.json<AuthStatusDto>('/api/v1/auth/status')).toMatchObject({ setupTokenRequired: true });
      expect((await client.fetch('/api/v1/auth/setup', { method: 'POST', json: { username: 'alice', displayName: 'A' } })).status).toBe(403);
      expect((await client.fetch('/api/v1/auth/setup', { method: 'POST', json: { username: 'alice', displayName: 'A', setupToken: 'wrong' } })).status).toBe(403);
      expect((await client.fetch('/api/v1/auth/setup', { method: 'POST', json: { username: 'alice', displayName: 'A', setupToken: 'let-me-in' } })).status).toBe(201);
    } finally {
      await guarded.close();
    }
  });

  it('validates usernames', async () => {
    const bad = ['ab', 'has space', '-leading', 'x'.repeat(40), ''];
    for (const username of bad) {
      expect((await anonymous().fetch('/api/v1/auth/setup', { method: 'POST', json: { username, displayName: 'X' } })).status).toBe(400);
    }
  });
});

describe('password + TOTP sign-in', () => {
  it('needs the second factor, burns each TOTP code once, and accepts a recovery code once', async () => {
    const { secret, recoveryCodes } = await setUpAdmin(url, clock);
    const login = async () => {
      const client = anonymous();
      const step1 = await client.json<LoginResultDto>('/api/v1/auth/login/password', { method: 'POST', json: { username: 'admin', password: PASSWORD } });
      expect(step1.status).toBe('mfa_required');
      return { client, mfaToken: (step1 as { mfaToken: string }).mfaToken };
    };

    // The password alone does not sign in.
    const first = await login();
    expect((await first.client.fetch('/api/v1/auth/me')).status).toBe(401);

    clock.advance();
    const code = totpCode(secret, clock);
    const ok = await first.client.json<LoginResultDto>('/api/v1/auth/login/totp', { method: 'POST', json: { mfaToken: first.mfaToken, code } });
    expect(ok).toMatchObject({ status: 'ok', me: { username: 'admin', enrolled: true } });
    expect((await first.client.fetch('/api/v1/auth/me')).status).toBe(200);

    // The same code again (a replay inside its window) is refused.
    const replay = await login();
    expect((await replay.client.fetch('/api/v1/auth/login/totp', { method: 'POST', json: { mfaToken: replay.mfaToken, code } })).status).toBe(401);

    // A recovery code works, once, in any case/format.
    const viaRecovery = await login();
    const recovery = recoveryCodes[0]!.toLowerCase().replace('-', ' ');
    expect((await viaRecovery.client.fetch('/api/v1/auth/login/totp', { method: 'POST', json: { mfaToken: viaRecovery.mfaToken, recoveryCode: recovery } })).status).toBe(200);
    const again = await login();
    expect((await again.client.fetch('/api/v1/auth/login/totp', { method: 'POST', json: { mfaToken: again.mfaToken, recoveryCode: recoveryCodes[0]! } })).status).toBe(401);
    expect((await first.client.json<MeDto>('/api/v1/auth/me')).recoveryCodesRemaining).toBe(9);
  });

  it('gives the same answer for a wrong password, an unknown user, and a password-only account', async () => {
    await setUpAdmin(url, clock);
    await prisma.user.create({ data: { username: 'pwonly', displayName: 'No TOTP', passwordHash: await hashPassword(PASSWORD) } });
    const attempt = async (username: string, password: string) => {
      const res = await anonymous().fetch('/api/v1/auth/login/password', { method: 'POST', json: { username, password } });
      return [res.status, await res.json()] as const;
    };
    const wrong = await attempt('admin', 'not the password!');
    expect(wrong[0]).toBe(401);
    expect(await attempt('nobody', PASSWORD)).toEqual(wrong);
    // Right password, but a password alone is not a way to sign in.
    expect(await attempt('pwonly', PASSWORD)).toEqual(wrong);
  });

  it('gives up on a half-finished sign-in after too many wrong second factors', async () => {
    const { secret } = await setUpAdmin(url, clock);
    const client = anonymous();
    const { mfaToken } = await client.json<{ mfaToken: string }>('/api/v1/auth/login/password', { method: 'POST', json: { username: 'admin', password: PASSWORD } });
    for (let i = 0; i < 5; i++) {
      expect((await client.fetch('/api/v1/auth/login/totp', { method: 'POST', json: { mfaToken, code: '000000' } })).status).toBe(401);
    }
    clock.advance();
    // Even the right code is refused now: the attempt is spent and the password step must be redone.
    expect((await client.fetch('/api/v1/auth/login/totp', { method: 'POST', json: { mfaToken, code: totpCode(secret, clock) } })).status).toBe(401);
  });

  it('requires exactly one of code / recoveryCode', async () => {
    const res = await anonymous().fetch('/api/v1/auth/login/totp', { method: 'POST', json: { mfaToken: 'x', code: '123456', recoveryCode: 'AAAAA-AAAAA' } });
    expect(res.status).toBe(400);
  });
});

describe('sessions and request safety', () => {
  it('refuses cookie-authenticated writes without the API header or from a foreign origin', async () => {
    const { client } = await setUpAdmin(url, clock);
    expect((await client.fetch('/api/v1/scan', { method: 'POST', csrf: false })).status).toBe(403);
    expect((await client.fetch('/api/v1/scan', { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await client.fetch('/api/v1/scan', { method: 'POST', headers: { origin: url } })).status).toBe(202);
    // Reads are not affected by either rule.
    expect((await client.fetch('/api/v1/auth/me', { csrf: false })).status).toBe(200);
  });

  it('rejects an unsafe request from a foreign origin even before sign-in', async () => {
    const res = await anonymous().fetch('/api/v1/auth/login/password', { method: 'POST', headers: { origin: 'https://evil.example' }, json: { username: 'a', password: 'b' } });
    expect(res.status).toBe(403);
  });

  it('sets a hardened cookie', async () => {
    const res = await fetch(`${url}/api/v1/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cookie', displayName: 'C' }) });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('bpmix_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  it('lists sessions, revokes one, and logs out', async () => {
    const { client, secret } = await setUpAdmin(url, clock);
    // A second browser signs in.
    const other = anonymous();
    const { mfaToken } = await other.json<{ mfaToken: string }>('/api/v1/auth/login/password', { method: 'POST', json: { username: 'admin', password: PASSWORD } });
    clock.advance();
    await other.post('/api/v1/auth/login/totp', { mfaToken, code: totpCode(secret, clock) });

    const sessions = await client.json<SessionSummaryDto[]>('/api/v1/auth/sessions');
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    const theirs = sessions.find((s) => !s.current)!;
    expect((await client.fetch(`/api/v1/auth/sessions/${theirs.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await other.fetch('/api/v1/auth/me')).status).toBe(401);

    expect((await client.fetch('/api/v1/auth/logout', { method: 'POST' })).status).toBe(204);
    expect((await client.fetch('/api/v1/auth/me')).status).toBe(401);
  });

  it('asks for a fresh sign-in before credential changes once a session has gone stale', async () => {
    const { client } = await setUpAdmin(url, clock);
    await prisma.session.updateMany({ data: { authenticatedAt: new Date(Date.now() - 60 * 60_000) } });
    const res = await client.fetch('/api/v1/auth/password', { method: 'POST', json: { password: 'another long password' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'reauth_required' });
    // Reading is unaffected.
    expect((await client.fetch('/api/v1/auth/me')).status).toBe(200);
  });

  it('will not turn TOTP off for someone with no passkey to fall back on', async () => {
    const { client, secret } = await setUpAdmin(url, clock);
    clock.advance();
    expect((await client.fetch('/api/v1/auth/totp/disable', { method: 'POST', json: { code: totpCode(secret, clock) } })).status).toBe(409);
  });
});

describe('admin-created users', () => {
  it('creates a user who enrolls through a one-time link, and can then use the app but not administer it', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const created = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'Bob', displayName: 'Bob B' });
    expect(created.user).toMatchObject({ username: 'bob', role: 'USER', enrolled: false, disabled: false });

    // Until Bob enrolls there is no way to sign in as him.
    expect((await anonymous().fetch('/api/v1/auth/login/password', { method: 'POST', json: { username: 'bob', password: PASSWORD } })).status).toBe(401);

    const bob = anonymous();
    expect(await bob.post<MeDto>('/api/v1/auth/invites/redeem', { inviteToken: created.invite.inviteToken })).toMatchObject({ username: 'bob', enrolled: false });
    // The link works once.
    expect((await anonymous().fetch('/api/v1/auth/invites/redeem', { method: 'POST', json: { inviteToken: created.invite.inviteToken } })).status).toBe(401);

    expect((await bob.fetch('/api/v1/tracks')).status).toBe(403);
    await bob.enrollPasswordAndTotp(clock);
    expect((await bob.fetch('/api/v1/tracks')).status).toBe(200);
    expect((await bob.fetch('/api/v1/users')).status).toBe(403);
    expect((await bob.fetch('/api/v1/scan')).status).toBe(403);
    expect((await bob.fetch('/api/v1/users', { method: 'POST', json: { username: 'eve', displayName: 'E' } })).status).toBe(403);

    expect((await admin.json<UserSummaryDto[]>('/api/v1/users')).map((u) => [u.username, u.role, u.enrolled])).toEqual([
      ['admin', 'ADMIN', true],
      ['bob', 'USER', true],
    ]);
  });

  it('rejects duplicate usernames, unknown and expired links', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    expect((await admin.fetch('/api/v1/users', { method: 'POST', json: { username: 'admin', displayName: 'Dup' } })).status).toBe(409);
    expect((await anonymous().fetch('/api/v1/auth/invites/redeem', { method: 'POST', json: { inviteToken: 'nope' } })).status).toBe(401);

    const { invite } = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'late', displayName: 'Late' });
    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await anonymous().fetch('/api/v1/auth/invites/redeem', { method: 'POST', json: { inviteToken: invite.inviteToken } })).status).toBe(401);
  });

  it('replaces an outstanding link when a new one is issued', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { user, invite } = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'carol', displayName: 'C' });
    const replacement = await admin.post<{ inviteToken: string }>(`/api/v1/users/${user.id}/invite`);
    expect((await anonymous().fetch('/api/v1/auth/invites/redeem', { method: 'POST', json: { inviteToken: invite.inviteToken } })).status).toBe(401);
    expect((await anonymous().fetch('/api/v1/auth/invites/redeem', { method: 'POST', json: { inviteToken: replacement.inviteToken } })).status).toBe(200);
  });

  it('disabling a user ends their sessions at once, and the last active admin cannot be removed', async () => {
    const { client: admin, me } = await setUpAdmin(url, clock);
    const { user, invite } = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'dave', displayName: 'D' });
    const dave = anonymous();
    await dave.post('/api/v1/auth/invites/redeem', { inviteToken: invite.inviteToken });
    await dave.enrollPasswordAndTotp(clock);
    expect((await dave.fetch('/api/v1/tracks')).status).toBe(200);

    expect((await admin.json<UserSummaryDto>(`/api/v1/users/${user.id}`, { method: 'PATCH', json: { disabled: true } })).disabled).toBe(true);
    expect((await dave.fetch('/api/v1/tracks')).status).toBe(401);
    expect((await anonymous().fetch('/api/v1/auth/login/password', { method: 'POST', json: { username: 'dave', password: PASSWORD } })).status).toBe(401);

    expect((await admin.fetch(`/api/v1/users/${me.id}`, { method: 'PATCH', json: { disabled: true } })).status).toBe(409);
    expect((await admin.fetch(`/api/v1/users/${me.id}`, { method: 'PATCH', json: { role: 'USER' } })).status).toBe(409);
    // With a second admin it is allowed.
    const { user: second } = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'erin', displayName: 'E', role: 'ADMIN' });
    expect((await admin.fetch(`/api/v1/users/${second.id}`, { method: 'PATCH', json: { role: 'ADMIN' } })).status).toBe(200);
    expect((await admin.fetch(`/api/v1/users/${me.id}`, { method: 'PATCH', json: { role: 'USER' } })).status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('throttles repeated sign-in attempts per address and username', async () => {
    const limited = await startApp({ BPMIX_AUTH_RATE_LIMIT: '3' });
    try {
      const client = new TestClient(await urlOf(limited));
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await client.fetch('/api/v1/auth/login/password', { method: 'POST', json: { username: 'someone', password: 'guess' } })).status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      // A different username has its own budget.
      expect((await client.fetch('/api/v1/auth/login/password', { method: 'POST', json: { username: 'another', password: 'guess' } })).status).toBe(401);
    } finally {
      await limited.close();
    }
  });
});

describe('legacy file routes', () => {
  it('are behind the same sign-in, with writes limited to admins', async () => {
    await mkdir(path.join(base, 'Music'), { recursive: true });
    await writeFile(path.join(base, 'Music', 'a.txt'), 'hello');
    const nest = await startApp({}, { legacy: true });
    try {
      const legacyUrl = await urlOf(nest);
      const guest = new TestClient(legacyUrl);
      expect((await guest.fetch('/library/Music/a.txt')).status).toBe(401);
      expect((await guest.fetch('/api/roots')).status).toBe(401);
      expect((await guest.fetch('/api/v1/health')).status).toBe(200); // the public v1 routes are not caught by it

      await resetDatabase(nest.get(DatabaseService).prisma);
      const { client: admin } = await setUpAdmin(legacyUrl, clock);
      expect(await (await admin.fetch('/library/Music/a.txt')).text()).toBe('hello');
      expect((await admin.fetch('/api/roots')).status).toBe(200);
      const put = (client: TestClient, headers: Record<string, string> = {}) =>
        client.fetch('/api/roots/Music/file?path=list.m3u8', { method: 'PUT', body: '#EXTM3U\n', headers: { 'content-type': 'text/plain', ...headers } });
      expect((await put(admin, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await put(admin)).status).toBe(204);

      const { invite } = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'viewer', displayName: 'V' });
      const viewer = new TestClient(legacyUrl);
      await viewer.post('/api/v1/auth/invites/redeem', { inviteToken: invite.inviteToken });
      expect((await viewer.fetch('/library/Music/a.txt')).status).toBe(403); // not enrolled yet
      clock.advance();
      await viewer.enrollPasswordAndTotp(clock);
      expect((await viewer.fetch('/library/Music/a.txt')).status).toBe(200);
      expect((await put(viewer)).status).toBe(403);
    } finally {
      await nest.close();
    }
  });
});

describe('web app hosting', () => {
  it('serves the app and falls back to index.html for page routes, without shadowing the API', async () => {
    const dist = path.join(base, 'web');
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>BPMix</title>');
    await writeFile(path.join(dist, 'app.js'), 'console.log(1)');
    // Mounted the way main.ts does: before init, so it can't sit behind Nest's 404 handler.
    for (const key of ['BPMIX_SETUP_TOKEN', 'BPMIX_ORIGIN']) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BPMIX_LIBRARY_ROOT: base, BPMIX_SCAN_ON_START: 'false', BPMIX_DATA_DIR: path.join(base, 'data') });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock.now).compile();
    const nest = moduleRef.createNestApplication();
    mountWebApp(nest, dist);
    await nest.init();
    await nest.listen(0);
    try {
      const site = await urlOf(nest);
      const guest = new TestClient(site);
      const home = await guest.fetch('/');
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('<title>BPMix</title>');
      expect(await (await guest.fetch('/app.js')).text()).toBe('console.log(1)');
      expect(await (await guest.fetch('/playlists/some-id')).text()).toContain('<title>BPMix</title>');
      // API paths are not swallowed by the fallback.
      expect(await (await guest.fetch('/api/v1/health')).json()).toMatchObject({ status: 'ok' });
      expect((await guest.fetch('/api/v1/auth/status')).status).toBe(200);
      expect((await guest.fetch('/api/v1/no-such-route')).status).toBe(404);
      expect((await guest.fetch('/api/v1/tracks')).status).toBe(401);
    } finally {
      await nest.close();
    }
  });
});
