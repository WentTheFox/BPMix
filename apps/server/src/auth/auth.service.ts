import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, UnauthorizedException, type OnApplicationBootstrap } from '@nestjs/common';
import type {
  CreateUserResultDto,
  InviteResultDto,
  MeDto,
  SessionSummaryDto,
  TotpSetupDto,
  UserSummaryDto,
} from '@bpmix/api';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../db/database.module.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AuthConfig } from './auth.config.js';
import { burnPasswordTime, hashPassword, verifyPassword } from './crypto/password.js';
import { generateRecoveryCodes, hashRecoveryCode, RECOVERY_CODE_COUNT } from './crypto/recoveryCodes.js';
import type { SecretBox } from './crypto/secretBox.js';
import { constantTimeEquals, generateToken, hashToken } from './crypto/tokens.js';
import { generateTotpSecret, totpUri, verifyTotp } from './crypto/totp.js';
import type { Principal, PrincipalUser } from './principal.js';

export const SECRET_BOX = Symbol('SECRET_BOX');
/** Time source for TOTP windows; tests replace it to step through them without waiting. */
export const CLOCK = Symbol('CLOCK');

export interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

type UserRow = Prisma.UserGetPayload<{ include: { _count: { select: { credentials: true } } } }>;

const WITH_CREDENTIAL_COUNT = { _count: { select: { credentials: true } } } as const;
/** SQL-side twin of isEnrolled(), for counting. */
const ENROLLED_WHERE: Prisma.UserWhereInput = {
  OR: [{ credentials: { some: {} } }, { AND: [{ passwordHash: { not: null } }, { totpEnabledAt: { not: null } }] }],
};

/** Signing in again later needs a passkey, or a password together with TOTP (a password alone never signs in). */
function isEnrolled(user: UserRow): boolean {
  return user._count.credentials > 0 || (user.passwordHash !== null && user.totpEnabledAt !== null);
}

function toPrincipalUser(user: UserRow): PrincipalUser {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, enrolled: isEnrolled(user) };
}

function toUserSummary(user: UserRow): UserSummaryDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabledAt !== null,
    enrolled: isEnrolled(user),
    createdAtMs: user.createdAt.getTime(),
  };
}

const INVALID_CREDENTIALS = 'Invalid credentials';

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AuthConfig,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Optional() @Inject(CLOCK) private readonly clock: () => number = Date.now,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if ((await this.enrolledUserCount()) === 0) {
      this.logger.warn(
        'No accounts exist yet: the first person to open the app and sign up becomes the admin.' +
          (this.config.setupToken ? ' (BPMIX_SETUP_TOKEN is required for that sign-up.)' : ' Set BPMIX_SETUP_TOKEN to require a secret for it.'),
      );
    }
  }

  private get prisma() {
    return this.db.prisma;
  }

  /**
   * Housekeeping: expired sessions, challenges and sign-in codes, and long-spent invites and revoked
   * tokens. Several routes are reachable before sign-in and create rows, so nothing is kept forever.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired(): Promise<void> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const quarterAgo = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
    const [sessions, challenges, grants, invites, tokens] = await Promise.all([
      this.prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
      this.prisma.authChallenge.deleteMany({ where: { expiresAt: { lt: now } } }),
      this.prisma.deviceGrant.deleteMany({ where: { expiresAt: { lt: now } } }),
      this.prisma.invite.deleteMany({ where: { OR: [{ usedAt: { lt: weekAgo } }, { expiresAt: { lt: weekAgo } }] } }),
      // Revoked tokens linger a while so a "device was removed" trail exists, then go.
      this.prisma.deviceToken.deleteMany({ where: { revokedAt: { lt: quarterAgo } } }),
    ]);
    const total = sessions.count + challenges.count + grants.count + invites.count + tokens.count;
    if (total > 0) this.logger.log(`Purged ${total} expired auth row(s)`);
  }

  // ---------------------------------------------------------------- status & setup

  enrolledUserCount(): Promise<number> {
    return this.prisma.user.count({ where: ENROLLED_WHERE });
  }

  async status(): Promise<{ setupRequired: boolean; setupTokenRequired: boolean }> {
    return { setupRequired: (await this.enrolledUserCount()) === 0, setupTokenRequired: this.config.setupToken !== undefined };
  }

  /**
   * The one open sign-up: allowed only while nobody has finished setting up an account, and the
   * result is an ADMIN. The caller is signed in straight away so they can enroll a way to sign in
   * again. They have a grace period to do that, during which other sign-ups are refused; if they
   * abandon it, the unfinished account is replaced afterwards, so a public server can't be left
   * permanently locked.
   */
  async setupFirstAdmin(input: { username: string; displayName: string; setupToken?: string }, meta: RequestMeta): Promise<{ user: PrincipalUser; session: IssuedSession }> {
    if (this.config.setupToken && !(input.setupToken && constantTimeEquals(input.setupToken, this.config.setupToken))) {
      throw new ForbiddenException('A valid setup token is required');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      // Serialises concurrent first sign-ups.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bpmix-first-signup'))`;
      if ((await tx.user.count({ where: ENROLLED_WHERE })) > 0) throw new ForbiddenException('Sign-up is closed; ask an admin to create an account for you');
      const graceEnds = new Date(Date.now() - this.config.setupGraceMs);
      await tx.user.deleteMany({ where: { NOT: ENROLLED_WHERE, createdAt: { lt: graceEnds } } });
      if ((await tx.user.count()) > 0) throw new ForbiddenException('Another sign-up is in progress; try again in a few minutes');
      const user = await tx.user.create({ data: { username: input.username, displayName: input.displayName, role: 'ADMIN' }, include: WITH_CREDENTIAL_COUNT });
      return { user, session: await this.createSession(user.id, meta, tx) };
    });
    this.logger.log(`First admin account "${result.user.username}" created`);
    return { user: toPrincipalUser(result.user), session: result.session };
  }

  /** The current picture of a user, e.g. right after a sign-in that only knows their id. */
  async principalUser(userId: string): Promise<PrincipalUser> {
    return toPrincipalUser(await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: WITH_CREDENTIAL_COUNT }));
  }

  // ---------------------------------------------------------------- sessions

  async createSession(userId: string, meta: RequestMeta, db: Pick<typeof this.prisma, 'session'> = this.prisma): Promise<IssuedSession> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.config.sessionTtlMs);
    await db.session.create({
      data: { id: hashToken(token), userId, expiresAt, userAgent: meta.userAgent?.slice(0, 300), ip: meta.ip },
    });
    return { token, expiresAt };
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const { count } = await this.prisma.session.deleteMany({ where: { id: sessionId, userId } });
    if (count === 0) throw new NotFoundException('No such session');
  }

  async revokeSessionByToken(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: hashToken(token) } });
  }

  async listSessions(userId: string, currentSessionId: string | undefined): Promise<SessionSummaryDto[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      // The id is already a hash of the cookie, safe to show; it's what DELETE /auth/sessions/:id takes.
      id: s.id,
      createdAtMs: s.createdAt.getTime(),
      lastSeenAtMs: s.lastSeenAt.getTime(),
      userAgent: s.userAgent,
      ip: s.ip,
      current: s.id === currentSessionId,
    }));
  }

  /** Resolves a session cookie or device bearer token to who it belongs to, or null. */
  async authenticate(credentials: { sessionToken?: string; bearerToken?: string }): Promise<Principal | null> {
    if (credentials.bearerToken) return this.authenticateDeviceToken(credentials.bearerToken);
    if (credentials.sessionToken) return this.authenticateSession(credentials.sessionToken);
    return null;
  }

  private async authenticateSession(token: string): Promise<Principal | null> {
    const now = new Date();
    const session = await this.prisma.session.findUnique({ where: { id: hashToken(token) }, include: { user: { include: WITH_CREDENTIAL_COUNT } } });
    if (!session || session.expiresAt <= now || session.user.disabledAt) return null;
    // Bookkeeping at most once a minute, and push the expiry out when it's under half left (sliding window).
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      const extend = session.expiresAt.getTime() - now.getTime() < this.config.sessionTtlMs / 2;
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, ...(extend ? { expiresAt: new Date(now.getTime() + this.config.sessionTtlMs) } : {}) },
      });
    }
    return { kind: 'session', user: toPrincipalUser(session.user), sessionId: session.id, authenticatedAt: session.authenticatedAt };
  }

  private async authenticateDeviceToken(token: string): Promise<Principal | null> {
    const row = await this.prisma.deviceToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { include: WITH_CREDENTIAL_COUNT } } });
    if (!row || row.revokedAt || row.user.disabledAt) return null;
    if (Date.now() - (row.lastUsedAt ?? row.createdAt).getTime() > this.config.deviceTokenIdleMs) return null;
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
      await this.prisma.deviceToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
    }
    return { kind: 'device', user: toPrincipalUser(row.user), deviceTokenId: row.id };
  }

  /** Sensitive changes (credentials, user management) need a recent sign-in, not just a live cookie. */
  requireFreshAuth(principal: Principal): void {
    const at = principal.authenticatedAt;
    if (principal.kind !== 'session' || !at || Date.now() - at.getTime() > this.config.freshAuthMs) {
      throw new ForbiddenException({ code: 'reauth_required', message: 'Please sign in again to do this' });
    }
  }

  // ---------------------------------------------------------------- password + TOTP login

  /**
   * A correct password is only the first step: sign-in also needs a TOTP or recovery code, and an
   * account without TOTP can't sign in by password at all. Every failure looks the same.
   */
  async loginWithPassword(username: string, password: string, meta: RequestMeta): Promise<{ mfaToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { username } });
    if (!user || !user.passwordHash || !user.totpEnabledAt || user.disabledAt) {
      await burnPasswordTime(password);
      this.logger.warn(`Failed password sign-in for "${username}" from ${meta.ip ?? 'unknown'}`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      this.logger.warn(`Failed password sign-in for "${username}" from ${meta.ip ?? 'unknown'}`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    const mfaToken = generateToken();
    await this.prisma.authChallenge.create({
      data: { id: hashToken(mfaToken), purpose: 'mfa', userId: user.id, data: { attempts: 0 }, expiresAt: new Date(Date.now() + this.config.mfaTtlMs) },
    });
    return { mfaToken };
  }

  async completeMfa(mfaToken: string, proof: { code?: string; recoveryCode?: string }, meta: RequestMeta): Promise<{ user: PrincipalUser; session: IssuedSession }> {
    const id = hashToken(mfaToken);
    const challenge = await this.prisma.authChallenge.findUnique({ where: { id } });
    if (!challenge || challenge.purpose !== 'mfa' || !challenge.userId || challenge.expiresAt <= new Date()) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    const attempts = (challenge.data as { attempts?: number } | null)?.attempts ?? 0;
    if (attempts >= this.config.maxMfaAttempts) {
      await this.prisma.authChallenge.deleteMany({ where: { id } });
      throw new UnauthorizedException('Too many attempts; sign in again');
    }
    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId }, include: WITH_CREDENTIAL_COUNT });
    const ok = user && !user.disabledAt && (proof.code !== undefined ? await this.acceptTotp(user.id, proof.code) : proof.recoveryCode !== undefined ? await this.acceptRecoveryCode(user.id, proof.recoveryCode) : false);
    if (!user || !ok) {
      await this.prisma.authChallenge.update({ where: { id }, data: { data: { attempts: attempts + 1 } } });
      this.logger.warn(`Failed second factor for user ${challenge.userId} from ${meta.ip ?? 'unknown'}`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    await this.prisma.authChallenge.deleteMany({ where: { id } });
    this.logger.log(`"${user.username}" signed in with password + ${proof.code !== undefined ? 'TOTP' : 'a recovery code'}`);
    return { user: toPrincipalUser(user), session: await this.createSession(user.id, meta) };
  }

  /** Verifies a TOTP code and burns its time step so it can't be replayed. */
  private async acceptTotp(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.totpSecretEnc || !user.totpEnabledAt) return false;
    const step = verifyTotp(this.box.open(user.totpSecretEnc), code, this.clock(), user.totpLastStep);
    if (step === null) return false;
    // Conditional update: of two simultaneous uses of one code, only one wins.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return count === 1;
  }

  private async acceptRecoveryCode(userId: string, code: string): Promise<boolean> {
    const { count } = await this.prisma.recoveryCode.updateMany({
      where: { userId, codeHash: hashRecoveryCode(code), usedAt: null },
      data: { usedAt: new Date() },
    });
    return count === 1;
  }

  // ---------------------------------------------------------------- the signed-in user's own account

  async me(principal: Principal): Promise<MeDto> {
    const userId = principal.user.id;
    const [user, passkeys, recoveryCodesRemaining] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: WITH_CREDENTIAL_COUNT }),
      this.prisma.credential.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.recoveryCode.count({ where: { userId, usedAt: null } }),
    ]);
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      enrolled: isEnrolled(user),
      hasPassword: user.passwordHash !== null,
      totpEnabled: user.totpEnabledAt !== null,
      passkeys: passkeys.map((c) => ({
        id: c.id,
        name: c.name,
        deviceType: c.deviceType,
        backedUp: c.backedUp,
        createdAtMs: c.createdAt.getTime(),
        lastUsedAtMs: c.lastUsedAt?.getTime() ?? null,
      })),
      recoveryCodesRemaining,
      authenticatedAtMs: principal.authenticatedAt?.getTime() ?? null,
      via: principal.kind,
    };
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } });
  }

  /** Starts TOTP enrollment: stores a new secret (sealed) that isn't active until a code from it is confirmed. */
  async beginTotp(userId: string): Promise<TotpSetupDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw new ConflictException('Two-factor authentication is already on; turn it off first to set it up again');
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: this.box.seal(secret), totpLastStep: null } });
    return { secret, otpauthUri: totpUri({ secret, accountName: user.username, issuer: this.config.rpName }) };
  }

  /** Confirms the secret with a code from the authenticator app, then turns TOTP on and returns recovery codes if there are none yet. */
  async enableTotp(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw new ConflictException('Two-factor authentication is already on');
    if (!user.totpSecretEnc) throw new BadRequestException('Start setup first');
    const step = verifyTotp(this.box.open(user.totpSecretEnc), code, this.clock());
    if (step === null) throw new BadRequestException('That code is not right; check the clock on your device and try again');
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date(), totpLastStep: step } });
    const unused = await this.prisma.recoveryCode.count({ where: { userId, usedAt: null } });
    return { recoveryCodes: unused > 0 ? [] : await this.replaceRecoveryCodes(userId) };
  }

  /** Turning TOTP off also ends password sign-in, so it needs a passkey to fall back on. */
  async disableTotp(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: WITH_CREDENTIAL_COUNT });
    if (!user.totpEnabledAt) throw new ConflictException('Two-factor authentication is not on');
    if (user._count.credentials === 0) throw new ConflictException('Add a passkey first; otherwise you could no longer sign in');
    if (!(await this.acceptTotp(userId, code))) throw new BadRequestException('That code is not right');
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: null, totpSecretEnc: null, totpLastStep: null } });
  }

  async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({ data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })) }),
    ]);
    return codes;
  }

  // ---------------------------------------------------------------- admin: users and invites

  async listUsers(): Promise<UserSummaryDto[]> {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' }, include: WITH_CREDENTIAL_COUNT });
    return users.map(toUserSummary);
  }

  /** Creates the account (no way to sign in yet) and an expiring link for its owner to set one up. */
  async createUser(input: { username: string; displayName: string; role: 'ADMIN' | 'USER' }, createdById: string): Promise<CreateUserResultDto> {
    if (await this.prisma.user.findUnique({ where: { username: input.username } })) throw new ConflictException('That username is taken');
    const user = await this.prisma.user.create({ data: input, include: WITH_CREDENTIAL_COUNT });
    this.logger.log(`Admin ${createdById} created user "${user.username}" (${user.role})`);
    return { user: toUserSummary(user), invite: await this.createInvite(user.id, createdById) };
  }

  /** A fresh one-time enrollment link (the first one for a new user, or a replacement for someone who lost their credentials). Older unused links stop working. */
  async createInvite(userId: string, createdById: string): Promise<InviteResultDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('No such user');
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.config.inviteTtlMs);
    await this.prisma.$transaction([
      this.prisma.invite.deleteMany({ where: { userId, usedAt: null } }),
      this.prisma.invite.create({ data: { tokenHash: hashToken(token), userId, createdById, expiresAt } }),
    ]);
    return { inviteToken: token, expiresAtMs: expiresAt.getTime() };
  }

  async redeemInvite(token: string, meta: RequestMeta): Promise<{ user: PrincipalUser; session: IssuedSession }> {
    const invite = await this.prisma.invite.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { include: WITH_CREDENTIAL_COUNT } } });
    if (!invite || invite.usedAt || invite.expiresAt <= new Date() || invite.user.disabledAt) {
      throw new UnauthorizedException('This link is invalid, expired or already used; ask an admin for a new one');
    }
    const { count } = await this.prisma.invite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: new Date() } });
    if (count !== 1) throw new UnauthorizedException('This link is invalid, expired or already used; ask an admin for a new one');
    this.logger.log(`"${invite.user.username}" opened an enrollment link`);
    return { user: toPrincipalUser(invite.user), session: await this.createSession(invite.user.id, meta) };
  }

  async updateUser(userId: string, patch: { displayName?: string; role?: 'ADMIN' | 'USER'; disabled?: boolean }, actorId: string): Promise<UserSummaryDto> {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('No such user');
    const losesAdmin = target.role === 'ADMIN' && target.disabledAt === null && (patch.role === 'USER' || patch.disabled === true);
    if (losesAdmin) {
      const others = await this.prisma.user.count({ where: { id: { not: userId }, role: 'ADMIN', disabledAt: null } });
      if (others === 0) throw new ConflictException('There must always be at least one active admin');
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? new Date() : null } : {}),
      },
      include: WITH_CREDENTIAL_COUNT,
    });
    if (patch.disabled === true) {
      // Cuts off browser sessions at once; device tokens and invites are refused by the disabled check.
      await this.prisma.session.deleteMany({ where: { userId } });
      this.logger.log(`Admin ${actorId} disabled "${user.username}"`);
    }
    return toUserSummary(user);
  }
}
