import { EventEmitter } from 'node:events';
import { ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import type { Request } from 'express';
import type { DeviceCodeResultDto, DeviceLookupDto, DeviceTokenSummaryDto, DeviceWaitResultDto } from '@beatseam/api';
import { DatabaseService } from '../db/database.module.js';
import { AuthConfig } from './auth.config.js';
import { AuthService } from './auth.service.js';
import { normalizeRecoveryCode, generateUserCode } from './crypto/recoveryCodes.js';
import { generateToken, hashToken } from './crypto/tokens.js';

const TOKEN_PREFIX = 'bpd_';

/** Same code however it's typed: case, dash and spaces don't matter. */
function normalizeUserCode(input: string): string {
  const compact = normalizeRecoveryCode(input);
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

/**
 * Sign-in for the native apps, which can't (all of them) do passkeys or show our login page: the app
 * gets a short code, the user approves it in a browser they're already signed in to, and the app is
 * handed a revocable per-device token. The app waits for that with a held-open request that is woken
 * the moment the approval happens - no timer loop on either side.
 */
@Injectable()
export class DeviceService implements OnModuleDestroy {
  private readonly logger = new Logger(DeviceService.name);
  private readonly decisions = new EventEmitter().setMaxListeners(0);
  private closing = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AuthConfig,
    private readonly auth: AuthService,
  ) {}

  onModuleDestroy(): void {
    this.closing = true;
    this.decisions.emit('close');
  }

  private get prisma() {
    return this.db.prisma;
  }

  async requestCode(deviceName: string, req: Request): Promise<DeviceCodeResultDto> {
    const deviceCode = generateToken();
    const expiresAt = new Date(Date.now() + this.config.deviceCodeTtlMs);
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = generateUserCode();
      try {
        await this.prisma.deviceGrant.create({ data: { deviceCodeHash: hashToken(deviceCode), userCode, deviceName, expiresAt } });
        const origin = this.config.allowedOrigins(req)[0]!;
        return { deviceCode, userCode, verificationUri: `${origin}/device?code=${userCode}`, expiresInSeconds: Math.round(this.config.deviceCodeTtlMs / 1000) };
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err; // only a user-code collision is worth retrying
      }
    }
    throw new ConflictException('Could not allocate a sign-in code; try again');
  }

  /** What the browser shows before the user approves ("Pixel 8 wants to sign in"). */
  async lookup(userCode: string): Promise<DeviceLookupDto> {
    const grant = await this.findPending(userCode);
    return { deviceName: grant.deviceName, requestedAtMs: grant.createdAt.getTime() };
  }

  async decide(userCode: string, approve: boolean, userId: string): Promise<void> {
    const grant = await this.findPending(userCode);
    // Only a still-pending grant can be decided, and only once.
    const { count } = await this.prisma.deviceGrant.updateMany({
      where: { id: grant.id, status: 'pending' },
      data: approve ? { status: 'approved', userId } : { status: 'denied' },
    });
    if (count !== 1) throw new NotFoundException('That sign-in request is no longer open');
    this.logger.log(`${approve ? 'Approved' : 'Denied'} device sign-in "${grant.deviceName}" for user ${userId}`);
    this.decisions.emit(grant.id);
  }

  private async findPending(userCode: string) {
    const grant = await this.prisma.deviceGrant.findUnique({ where: { userCode: normalizeUserCode(userCode) } });
    if (!grant || grant.status !== 'pending' || grant.expiresAt <= new Date()) throw new NotFoundException('That code is not valid or has expired');
    return grant;
  }

  /** Holds the request until the grant is decided or the wait elapses ('pending' - the app just asks again). */
  async wait(deviceCode: string): Promise<DeviceWaitResultDto> {
    const hash = hashToken(deviceCode);
    const first = await this.resolve(hash);
    if (first.done) return first.result;
    const grantId = first.grantId;

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.decisions.off(grantId, finish);
        this.decisions.off('close', finish);
        resolve();
      };
      const timer = setTimeout(finish, this.config.deviceWaitMs);
      this.decisions.once(grantId, finish);
      this.decisions.once('close', finish);
    });
    if (this.closing) return { status: 'pending' };
    const next = await this.resolve(hash);
    return next.done ? next.result : { status: 'pending' };
  }

  private async resolve(hash: string): Promise<{ done: true; result: DeviceWaitResultDto } | { done: false; grantId: string }> {
    const grant = await this.prisma.deviceGrant.findUnique({ where: { deviceCodeHash: hash } });
    if (!grant || grant.status === 'claimed' || grant.expiresAt <= new Date()) {
      if (grant) await this.prisma.deviceGrant.deleteMany({ where: { id: grant.id } });
      return { done: true, result: { status: 'expired' } };
    }
    if (grant.status === 'denied') {
      await this.prisma.deviceGrant.deleteMany({ where: { id: grant.id } });
      return { done: true, result: { status: 'denied' } };
    }
    if (grant.status === 'pending' || !grant.userId) return { done: false, grantId: grant.id };

    // Approved: hand the token over exactly once.
    const { count } = await this.prisma.deviceGrant.updateMany({ where: { id: grant.id, status: 'approved' }, data: { status: 'claimed' } });
    if (count !== 1) return { done: true, result: { status: 'expired' } };
    const token = `${TOKEN_PREFIX}${generateToken()}`;
    await this.prisma.deviceToken.create({ data: { userId: grant.userId, name: grant.deviceName, tokenHash: hashToken(token) } });
    await this.prisma.deviceGrant.deleteMany({ where: { id: grant.id } });
    const user = await this.auth.principalUser(grant.userId);
    const me = await this.auth.me({ kind: 'device', user });
    return { done: true, result: { status: 'approved', token, me } };
  }

  async listTokens(userId: string): Promise<DeviceTokenSummaryDto[]> {
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'asc' } });
    return tokens.map((t) => ({ id: t.id, name: t.name, createdAtMs: t.createdAt.getTime(), lastUsedAtMs: t.lastUsedAt?.getTime() ?? null }));
  }

  /** Takes effect on the device's very next request. */
  async revokeToken(userId: string, tokenId: string): Promise<void> {
    const { count } = await this.prisma.deviceToken.updateMany({ where: { id: tokenId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (count === 0) throw new NotFoundException('No such device');
  }
}
