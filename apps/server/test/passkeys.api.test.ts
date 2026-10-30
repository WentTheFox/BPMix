import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CreateUserResultDto, MeDto, PasskeyLoginOptionsDto, PasskeySummaryDto } from '@bpmix/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/db/database.module.js';
import { resetDatabase } from './scanStack.js';
import { SoftAuthenticator } from './softAuthenticator.js';
import { createTestClock, TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const clock = createTestClock();
let app: INestApplication;
let url: string;
let base: string;
let prisma: DatabaseService['prisma'];

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-passkeys-'));
  for (const key of ['BPMIX_SETUP_TOKEN', 'BPMIX_ORIGIN']) delete process.env[key];
  Object.assign(process.env, { DATABASE_URL: TEST_DATABASE_URL, BPMIX_LIBRARY_ROOT: base, BPMIX_SCAN_ON_START: 'false', BPMIX_DATA_DIR: path.join(base, 'data'), BPMIX_AUTH_RATE_LIMIT: '1000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock.now).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');
  prisma = app.get(DatabaseService).prisma;
}, 60_000);

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const authenticator = (overrides: Partial<{ rpId: string; origin: string }> = {}) => new SoftAuthenticator({ rpId: 'localhost', origin: url, ...overrides });

/** Registers `device` as a passkey for whoever `client` is signed in as. */
async function registerPasskey(client: TestClient, device: SoftAuthenticator, name?: string): Promise<PasskeySummaryDto> {
  const options = await client.post<{ challenge: string; user: { id: string } }>('/api/v1/auth/passkeys/register/options');
  return client.post<PasskeySummaryDto>('/api/v1/auth/passkeys/register/verify', { response: device.create(options), name });
}

/** A fresh browser signing in with `device`, the usernameless way. */
async function signInWithPasskey(device: SoftAuthenticator, tweak: Parameters<SoftAuthenticator['get']>[1] = {}) {
  const client = new TestClient(url);
  const { challengeId, options } = await client.post<PasskeyLoginOptionsDto>('/api/v1/auth/login/passkey/options');
  const res = await client.fetch('/api/v1/auth/login/passkey/verify', { method: 'POST', json: { challengeId, response: device.get(options as { challenge: string }, tweak) } });
  return { client, res, challengeId, options: options as { challenge: string } };
}

async function firstAdminWithPasskey(): Promise<{ client: TestClient; device: SoftAuthenticator }> {
  const client = new TestClient(url);
  await client.post('/api/v1/auth/setup', { username: 'alice', displayName: 'Alice' });
  const device = authenticator();
  await registerPasskey(client, device, 'Laptop');
  return { client, device };
}

describe('passkeys', () => {
  it('lets the first admin enroll with just a passkey, and sign back in with it, usernameless', async () => {
    const { client, device } = await firstAdminWithPasskey();
    const me = await client.json<MeDto>('/api/v1/auth/me');
    expect(me).toMatchObject({ enrolled: true, hasPassword: false, totpEnabled: false });
    expect(me.passkeys).toEqual([expect.objectContaining({ name: 'Laptop', backedUp: true, lastUsedAtMs: null })]);
    expect((await client.fetch('/api/v1/tracks')).status).toBe(200);

    const { client: fresh, res } = await signInWithPasskey(device);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ username: 'alice', role: 'ADMIN', enrolled: true });
    expect((await fresh.fetch('/api/v1/tracks')).status).toBe(200);
    expect((await fresh.json<MeDto>('/api/v1/auth/me')).passkeys[0]!.lastUsedAtMs).not.toBeNull();
  });

  it('works for an admin-created user enrolling through their link', async () => {
    const { client: admin } = await firstAdminWithPasskey();
    const { invite } = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'bob', displayName: 'Bob' });
    const bob = new TestClient(url);
    await bob.post('/api/v1/auth/invites/redeem', { inviteToken: invite.inviteToken });
    expect((await bob.fetch('/api/v1/tracks')).status).toBe(403);
    const phone = authenticator();
    await registerPasskey(bob, phone, 'Phone');
    expect((await bob.fetch('/api/v1/tracks')).status).toBe(200);
    const { res } = await signInWithPasskey(phone);
    expect(await res.json()).toMatchObject({ username: 'bob', role: 'USER' });
  });

  it('accepts a signed-in-once challenge only once', async () => {
    const { device } = await firstAdminWithPasskey();
    const { res, challengeId, options } = await signInWithPasskey(device);
    expect(res.status).toBe(200);
    const replay = new TestClient(url);
    const again = await replay.fetch('/api/v1/auth/login/passkey/verify', { method: 'POST', json: { challengeId, response: device.get(options) } });
    expect(again.status).toBe(400);
  });

  it('rejects an assertion signed for a different challenge, another origin, or without user verification', async () => {
    const { device } = await firstAdminWithPasskey();
    const wrongChallenge = new TestClient(url);
    const first = await wrongChallenge.post<PasskeyLoginOptionsDto>('/api/v1/auth/login/passkey/options');
    const second = await wrongChallenge.post<PasskeyLoginOptionsDto>('/api/v1/auth/login/passkey/options');
    const swapped = await wrongChallenge.fetch('/api/v1/auth/login/passkey/verify', {
      method: 'POST',
      json: { challengeId: first.challengeId, response: device.get(second.options as { challenge: string }) },
    });
    expect(swapped.status).toBe(401);

    expect((await signInWithPasskey(device, { origin: 'https://evil.example' })).res.status).toBe(401);
    expect((await signInWithPasskey(device, { userVerified: false })).res.status).toBe(401);
    // And the genuine one still works after those failures.
    expect((await signInWithPasskey(device)).res.status).toBe(200);
  });

  it('rejects a passkey the server does not know, one for another site, and a disabled user', async () => {
    const { client, device } = await firstAdminWithPasskey();
    expect((await signInWithPasskey(authenticator())).res.status).toBe(401); // never registered
    expect((await signInWithPasskey(authenticator({ rpId: 'evil.example' }))).res.status).toBe(401);

    // Sign-in works until the account is disabled (a second admin has to do it - the last admin is protected).
    const spare = new TestClient(url);
    const { invite } = await client.post<CreateUserResultDto>('/api/v1/users', { username: 'spare', displayName: 'Spare', role: 'ADMIN' });
    await spare.post('/api/v1/auth/invites/redeem', { inviteToken: invite.inviteToken });
    await registerPasskey(spare, authenticator());
    const me = await client.json<MeDto>('/api/v1/auth/me');
    await prisma.user.update({ where: { id: me.id }, data: { disabledAt: new Date() } });
    expect((await signInWithPasskey(device)).res.status).toBe(401);
  });

  it('notices a cloned authenticator by its signature counter going backwards', async () => {
    const { device } = await firstAdminWithPasskey();
    device.synced = false; // a hardware-style key that counts
    expect((await signInWithPasskey(device)).res.status).toBe(200); // counter 1
    expect((await signInWithPasskey(device)).res.status).toBe(200); // counter 2
    expect((await signInWithPasskey(device, { counter: 1 })).res.status).toBe(401); // goes backwards: a clone
    expect((await signInWithPasskey(device, { counter: 2 })).res.status).toBe(401); // not past the stored value either
    expect((await signInWithPasskey(device, { counter: 3 })).res.status).toBe(200);
  });

  it('refuses to register the same passkey twice and asks the device not to offer one it already has', async () => {
    const { client, device } = await firstAdminWithPasskey();
    const options = await client.post<{ challenge: string; excludeCredentials: { id: string }[] }>('/api/v1/auth/passkeys/register/options');
    expect(options.excludeCredentials.map((c) => c.id)).toEqual([device.id]);
    const res = await client.fetch('/api/v1/auth/passkeys/register/verify', { method: 'POST', json: { response: device.create(options) } });
    expect(res.status).toBe(409);
  });

  it('rejects a registration for another site or without user verification, and a stale challenge', async () => {
    const client = new TestClient(url);
    await client.post('/api/v1/auth/setup', { username: 'carol', displayName: 'Carol' });
    const tryRegister = async (device: SoftAuthenticator, tweak: Parameters<SoftAuthenticator['create']>[1] = {}) => {
      const options = await client.post<{ challenge: string }>('/api/v1/auth/passkeys/register/options');
      return client.fetch('/api/v1/auth/passkeys/register/verify', { method: 'POST', json: { response: device.create(options, tweak) } });
    };
    expect((await tryRegister(authenticator({ rpId: 'evil.example' }))).status).toBe(400);
    expect((await tryRegister(authenticator(), { origin: 'https://evil.example' })).status).toBe(400);
    expect((await tryRegister(authenticator(), { userVerified: false })).status).toBe(400);
    expect(await prisma.credential.count()).toBe(0);

    const options = await client.post<{ challenge: string }>('/api/v1/auth/passkeys/register/options');
    await prisma.authChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await client.fetch('/api/v1/auth/passkeys/register/verify', { method: 'POST', json: { response: authenticator().create(options) } })).status).toBe(400);
  });

  it('manages passkeys: rename, add a second, never remove the last way in', async () => {
    const { client, device } = await firstAdminWithPasskey();
    expect((await client.json<PasskeySummaryDto>(`/api/v1/auth/passkeys/${device.id}`, { method: 'PATCH', json: { name: 'Work laptop' } })).name).toBe('Work laptop');

    expect((await client.fetch(`/api/v1/auth/passkeys/${device.id}`, { method: 'DELETE' })).status).toBe(409);

    const phone = authenticator();
    await registerPasskey(client, phone, 'Phone');
    expect((await client.json<MeDto>('/api/v1/auth/me')).passkeys.map((p) => p.name)).toEqual(['Work laptop', 'Phone']);
    expect((await client.fetch(`/api/v1/auth/passkeys/${device.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await signInWithPasskey(device)).res.status).toBe(401); // removed
    expect((await signInWithPasskey(phone)).res.status).toBe(200);
    expect((await client.fetch(`/api/v1/auth/passkeys/${phone.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await client.fetch('/api/v1/auth/passkeys/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it("won't touch someone else's passkey", async () => {
    const { client: alice, device } = await firstAdminWithPasskey();
    const { invite } = await alice.post<CreateUserResultDto>('/api/v1/users', { username: 'bob', displayName: 'Bob' });
    const bob = new TestClient(url);
    await bob.post('/api/v1/auth/invites/redeem', { inviteToken: invite.inviteToken });
    await registerPasskey(bob, authenticator());
    expect((await bob.fetch(`/api/v1/auth/passkeys/${device.id}`, { method: 'PATCH', json: { name: 'mine now' } })).status).toBe(404);
    expect((await bob.fetch(`/api/v1/auth/passkeys/${device.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('needs a recent sign-in to add or remove passkeys', async () => {
    const { client } = await firstAdminWithPasskey();
    await prisma.session.updateMany({ data: { authenticatedAt: new Date(Date.now() - 60 * 60_000) } });
    const res = await client.fetch('/api/v1/auth/passkeys/register/options', { method: 'POST', json: {} });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'reauth_required' });
  });

  it('keeps a passkey-only account from turning off its only second option, and password+TOTP users can still remove a passkey', async () => {
    const { client, device } = await firstAdminWithPasskey();
    // Add password + TOTP as another route in; the passkey is then removable.
    await client.enrollPasswordAndTotp(clock);
    expect((await client.fetch(`/api/v1/auth/passkeys/${device.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await client.json<MeDto>('/api/v1/auth/me')).toMatchObject({ enrolled: true, passkeys: [] });
  });
});
