import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CreateUserResultDto, DeviceCodeResultDto, DeviceLookupDto, DeviceTokenSummaryDto, DeviceWaitResultDto, MeDto } from '@bpmix/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/auth/auth.service.js';
import { DatabaseService } from '../src/db/database.module.js';
import { resetDatabase } from './scanStack.js';
import { createTestClock, setUpAdmin, TestClient } from './testClient.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

const clock = createTestClock();
let app: INestApplication;
let url: string;
let base: string;
let prisma: DatabaseService['prisma'];

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-device-'));
  delete process.env.BPMIX_ORIGIN;
  process.env.BPMIX_SETUP_TOKEN = 'none'; // open first sign-up, as most tests set up an admin directly
  Object.assign(process.env, {
    DATABASE_URL: TEST_DATABASE_URL,
    BPMIX_LIBRARY_ROOT: base,
    BPMIX_SCAN_ON_START: 'false',
    BPMIX_DATA_DIR: path.join(base, 'data'),
    BPMIX_AUTH_RATE_LIMIT: '1000',
    BPMIX_DEVICE_WAIT_MS: '1500',
  });
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

const waitFor = (app: TestClient, deviceCode: string) => app.json<DeviceWaitResultDto>('/api/v1/auth/device/wait', { method: 'POST', json: { deviceCode } });

/** A native app asks for a code. */
async function startDevice(name = 'Pixel 8') {
  const device = new TestClient(url);
  const grant = await device.post<DeviceCodeResultDto>('/api/v1/auth/device/code', { deviceName: name });
  return { device, grant };
}

/** The whole flow, ending with a device client that holds a working token. */
async function signInDevice(admin: TestClient, name = 'Pixel 8'): Promise<{ device: TestClient; token: string }> {
  const { device, grant } = await startDevice(name);
  expect((await admin.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode: grant.userCode, approve: true } })).status).toBe(204);
  const result = await waitFor(device, grant.deviceCode);
  if (result.status !== 'approved') throw new Error(`expected approved, got ${result.status}`);
  device.bearer = result.token;
  return { device, token: result.token };
}

describe('device sign-in', () => {
  it('gives an approved app a token that works for the library but not for administration or credentials', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { device, grant } = await startDevice('Living-room PC');
    expect(grant.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(grant.verificationUri).toBe(`${url}/device?code=${grant.userCode}`);
    expect(grant.expiresInSeconds).toBe(600);

    // Before approval the app just keeps being told 'pending' (here after the held request times out).
    expect(await waitFor(device, grant.deviceCode)).toEqual({ status: 'pending' });

    expect(await admin.json<DeviceLookupDto>(`/api/v1/auth/device/lookup?userCode=${grant.userCode}`)).toMatchObject({ deviceName: 'Living-room PC' });
    expect((await admin.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode: grant.userCode, approve: true } })).status).toBe(204);
    const result = await waitFor(device, grant.deviceCode);
    expect(result).toMatchObject({ status: 'approved', me: { username: 'admin', via: 'device' } });
    const token = (result as { token: string }).token;
    expect(token).toMatch(/^bpd_[A-Za-z0-9_-]{43}$/);
    device.bearer = token;

    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(200);
    expect(await device.json<MeDto>('/api/v1/auth/me', { csrf: false })).toMatchObject({ username: 'admin', via: 'device' });
    // Not a session: no administration, no credential management, no way to mint more tokens.
    for (const [method, route] of [['GET', '/api/v1/scan'], ['GET', '/api/v1/users'], ['GET', '/api/v1/auth/sessions'], ['GET', '/api/v1/auth/devices'], ['POST', '/api/v1/auth/password'], ['POST', '/api/v1/auth/device/approve']] as const) {
      expect((await device.fetch(route, { method, json: method === 'POST' ? {} : undefined, csrf: false })).status, `${method} ${route}`).toBe(403);
    }
    // The token is stored only as a hash.
    expect(await prisma.deviceToken.findMany({ select: { tokenHash: true } })).toEqual([{ tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it('wakes the waiting app as soon as the user approves, rather than at the end of the wait', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { device, grant } = await startDevice();
    const startedAt = Date.now();
    const waiting = waitFor(device, grant.deviceCode);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Typed sloppily - lower case, a space instead of the dash - the code still matches.
    expect((await admin.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode: grant.userCode.toLowerCase().replace('-', ' '), approve: true } })).status).toBe(204);
    const result = await waiting;
    expect(result.status).toBe('approved');
    expect(Date.now() - startedAt).toBeLessThan(1000); // the wait is 1.5s; this came back well before it
  });

  it('reports a denial once and then treats the request as gone', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { device, grant } = await startDevice();
    expect((await admin.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode: grant.userCode, approve: false } })).status).toBe(204);
    expect(await waitFor(device, grant.deviceCode)).toEqual({ status: 'denied' });
    expect(await waitFor(device, grant.deviceCode)).toEqual({ status: 'expired' });
    expect(await prisma.deviceToken.count()).toBe(0);
  });

  it('hands the token over exactly once, even to two simultaneous waiters', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { device, grant } = await startDevice();
    await admin.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode: grant.userCode, approve: true } });
    const results = await Promise.all([waitFor(device, grant.deviceCode), waitFor(device, grant.deviceCode), waitFor(device, grant.deviceCode)]);
    expect(results.map((r) => r.status).sort()).toEqual(['approved', 'expired', 'expired']);
    expect(await prisma.deviceToken.count()).toBe(1);
    expect(await waitFor(device, grant.deviceCode)).toEqual({ status: 'expired' });
  });

  it('refuses unknown, expired and already-decided codes, and a decision from someone not signed in', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const approve = (userCode: string, client = admin) => client.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode, approve: true } });
    expect((await approve('ZZZZ-ZZZZ')).status).toBe(404);

    const { grant } = await startDevice();
    expect((await approve(grant.userCode, new TestClient(url))).status).toBe(401);
    await prisma.deviceGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await approve(grant.userCode)).status).toBe(404);
    expect((await admin.fetch(`/api/v1/auth/device/lookup?userCode=${grant.userCode}`)).status).toBe(404);

    const { device, grant: second } = await startDevice();
    expect((await approve(second.userCode)).status).toBe(204);
    expect((await approve(second.userCode)).status).toBe(404); // decided already
    expect((await waitFor(device, second.deviceCode)).status).toBe('approved');
    expect(await waitFor(new TestClient(url), 'made-up-device-code')).toEqual({ status: 'expired' });
  });

  it('expires a grant that was never approved', async () => {
    const { device, grant } = await startDevice();
    await prisma.deviceGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await waitFor(device, grant.deviceCode)).toEqual({ status: 'expired' });
  });

  it('needs a recent sign-in and a finished enrollment to approve', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { grant } = await startDevice();
    await prisma.session.updateMany({ data: { authenticatedAt: new Date(Date.now() - 60 * 60_000) } });
    const res = await admin.fetch('/api/v1/auth/device/approve', { method: 'POST', json: { userCode: grant.userCode, approve: true } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'reauth_required' });
  });

  it('lists devices and revokes one, cutting it off on its very next request', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { device } = await signInDevice(admin, 'Tablet');
    const { device: other } = await signInDevice(admin, 'Phone');
    const devices = await admin.json<DeviceTokenSummaryDto[]>('/api/v1/auth/devices');
    expect(devices.map((d) => d.name)).toEqual(['Tablet', 'Phone']);
    expect(devices[0]!.lastUsedAtMs).toBeNull();

    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(200);
    expect((await admin.fetch(`/api/v1/auth/devices/${devices[0]!.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(401);
    expect((await other.fetch('/api/v1/tracks', { csrf: false })).status).toBe(200);
    expect((await admin.json<DeviceTokenSummaryDto[]>('/api/v1/auth/devices')).map((d) => d.name)).toEqual(['Phone']);
    expect((await admin.fetch(`/api/v1/auth/devices/${devices[0]!.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('lets an app sign itself out, cutting off just its own token', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { device } = await signInDevice(admin, 'Phone');
    const { device: other } = await signInDevice(admin, 'Tablet');
    expect((await device.fetch('/api/v1/auth/me/token', { method: 'DELETE', csrf: false })).status).toBe(204);
    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(401);
    expect((await other.fetch('/api/v1/tracks', { csrf: false })).status).toBe(200);
    expect((await admin.json<DeviceTokenSummaryDto[]>('/api/v1/auth/devices')).map((d) => d.name)).toEqual(['Tablet']);
    // A browser session has no token to revoke this way.
    expect((await admin.fetch('/api/v1/auth/me/token', { method: 'DELETE' })).status).toBe(400);
  });

  it("won't let one user list or revoke another's devices", async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { device } = await signInDevice(admin, 'Admin phone');
    const { invite } = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'bob', displayName: 'Bob' });
    const bob = new TestClient(url);
    await bob.post('/api/v1/auth/invites/redeem', { inviteToken: invite.inviteToken });
    clock.advance();
    await bob.enrollPasswordAndTotp(clock);
    expect(await bob.json<DeviceTokenSummaryDto[]>('/api/v1/auth/devices')).toEqual([]);
    const [adminDevice] = await admin.json<DeviceTokenSummaryDto[]>('/api/v1/auth/devices');
    expect((await bob.fetch(`/api/v1/auth/devices/${adminDevice!.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(200);
  });

  it('stops working when the user is disabled, when idle too long, or when the bearer is junk (without falling back to a cookie)', async () => {
    const { client: admin } = await setUpAdmin(url, clock);
    const { invite, user } = await admin.post<CreateUserResultDto>('/api/v1/users', { username: 'dora', displayName: 'Dora' });
    const dora = new TestClient(url);
    await dora.post('/api/v1/auth/invites/redeem', { inviteToken: invite.inviteToken });
    clock.advance();
    await dora.enrollPasswordAndTotp(clock);
    const { device } = await signInDevice(dora, 'Dora phone');
    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(200);

    // Idle for longer than the limit.
    await prisma.deviceToken.updateMany({ data: { lastUsedAt: new Date(Date.now() - 200 * 24 * 60 * 60_000) } });
    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(401);
    await prisma.deviceToken.updateMany({ data: { lastUsedAt: new Date() } });
    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(200);

    expect((await admin.fetch(`/api/v1/users/${user.id}`, { method: 'PATCH', json: { disabled: true } })).status).toBe(200);
    expect((await device.fetch('/api/v1/tracks', { csrf: false })).status).toBe(401);

    // A bad bearer is refused even when a perfectly good session cookie rides along.
    const confused = new TestClient(url);
    confused.cookie = admin.cookie;
    confused.bearer = 'bpd_not-a-real-token';
    expect((await confused.fetch('/api/v1/tracks', { csrf: false })).status).toBe(401);
  });

  it('throttles code requests like any other sign-in route', async () => {
    process.env.BPMIX_AUTH_RATE_LIMIT = '2'; // read on every request, so it has to stay set while we make them
    let limited: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock.now).compile();
      limited = moduleRef.createNestApplication();
      await limited.init();
      await limited.listen(0);
      const client = new TestClient((await limited.getUrl()).replace('[::1]', 'localhost'));
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await client.fetch('/api/v1/auth/device/code', { method: 'POST', json: { deviceName: 'x' } })).status);
      expect(statuses).toEqual([201, 201, 429, 429]);
    } finally {
      process.env.BPMIX_AUTH_RATE_LIMIT = '1000';
      await limited?.close();
    }
  });
});
