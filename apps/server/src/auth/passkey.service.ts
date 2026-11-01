import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Request } from 'express';
import type { PasskeyLoginOptionsDto, PasskeySummaryDto } from '@beatseam/api';
import { DatabaseService } from '../db/database.module.js';
import { AuthConfig } from './auth.config.js';
import { AuthService, type IssuedSession, type RequestMeta } from './auth.service.js';
import { generateToken, hashToken } from './crypto/tokens.js';
import type { PrincipalUser } from './principal.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const REGISTRATION = 'webauthn-registration';
const AUTHENTICATION = 'webauthn-authentication';

/**
 * Passkeys. A passkey is a complete sign-in on its own (possession of the device plus its
 * biometric/PIN), so user verification is required, not merely preferred. Sign-in is usernameless:
 * the device offers the passkeys it holds for this site, which also means the server never reveals
 * which usernames exist.
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AuthConfig,
    private readonly auth: AuthService,
  ) {}

  private get prisma() {
    return this.db.prisma;
  }

  async registrationOptions(userId: string, req: Request): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { credentials: { select: { id: true, transports: true } } } });
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId(req),
      userName: user.username,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      // Don't offer a device that already holds one of this account's passkeys.
      excludeCredentials: user.credentials.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const id = `reg:${userId}`;
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await this.prisma.authChallenge.upsert({
      where: { id },
      create: { id, purpose: REGISTRATION, challenge: options.challenge, userId, expiresAt },
      update: { purpose: REGISTRATION, challenge: options.challenge, expiresAt },
    });
    return options as unknown as Record<string, unknown>;
  }

  async verifyRegistration(userId: string, response: Record<string, unknown>, name: string | undefined, req: Request): Promise<PasskeySummaryDto> {
    // Single-use: taking the challenge deletes it, so a response can't be replayed or retried against it.
    const challenge = await this.takeChallenge(`reg:${userId}`, REGISTRATION);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.config.allowedOrigins(req),
        expectedRPID: this.config.rpId(req),
        requireUserVerification: true,
      });
    } catch (err) {
      this.logger.warn(`Passkey registration failed for ${userId}: ${String(err)}`);
      throw new BadRequestException('That passkey could not be verified');
    }
    if (!verification.verified) throw new BadRequestException('That passkey could not be verified');

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    if (await this.prisma.credential.findUnique({ where: { id: credential.id } })) throw new ConflictException('That passkey is already registered');
    const count = await this.prisma.credential.count({ where: { userId } });
    const created = await this.prisma.credential.create({
      data: {
        id: credential.id,
        userId,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name: name ?? `Passkey ${count + 1}`,
      },
    });
    this.logger.log(`User ${userId} registered a passkey (${credentialDeviceType}${credentialBackedUp ? ', synced' : ''})`);
    return toSummary(created);
  }

  async rename(userId: string, credentialId: string, name: string): Promise<PasskeySummaryDto> {
    const { count } = await this.prisma.credential.updateMany({ where: { id: credentialId, userId }, data: { name } });
    if (count === 0) throw new NotFoundException('No such passkey');
    return toSummary(await this.prisma.credential.findUniqueOrThrow({ where: { id: credentialId } }));
  }

  /** Refuses to remove the last way to sign in. */
  async remove(userId: string, credentialId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      if (!(await tx.credential.findFirst({ where: { id: credentialId, userId }, select: { id: true } }))) throw new NotFoundException('No such passkey');
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, include: { _count: { select: { credentials: true } } } });
      const passwordAndTotp = user.passwordHash !== null && user.totpEnabledAt !== null;
      if (user._count.credentials <= 1 && !passwordAndTotp) throw new ConflictException('This is your only way to sign in; add another before removing it');
      await tx.credential.delete({ where: { id: credentialId } });
    });
  }

  async authenticationOptions(req: Request): Promise<PasskeyLoginOptionsDto> {
    const options = await generateAuthenticationOptions({ rpID: this.config.rpId(req), userVerification: 'required' });
    const challengeId = generateToken();
    await this.prisma.authChallenge.create({
      data: { id: hashToken(challengeId), purpose: AUTHENTICATION, challenge: options.challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
    });
    return { challengeId, options: options as unknown as Record<string, unknown> };
  }

  async verifyAuthentication(challengeId: string, response: Record<string, unknown>, req: Request, meta: RequestMeta): Promise<{ user: PrincipalUser; session: IssuedSession }> {
    const challenge = await this.takeChallenge(hashToken(challengeId), AUTHENTICATION);
    const credentialId = typeof response.id === 'string' ? response.id : '';
    const stored = await this.prisma.credential.findUnique({ where: { id: credentialId }, include: { user: true } });
    const reject = (why: string): never => {
      this.logger.warn(`Failed passkey sign-in from ${meta.ip ?? 'unknown'}: ${why}`);
      throw new UnauthorizedException('Invalid credentials');
    };
    if (!stored || stored.user.disabledAt) return reject('unknown credential or disabled user');

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.config.allowedOrigins(req),
        expectedRPID: this.config.rpId(req),
        credential: { id: stored.id, publicKey: new Uint8Array(stored.publicKey), counter: Number(stored.counter), transports: stored.transports },
        requireUserVerification: true,
      });
    } catch (err) {
      return reject(String(err));
    }
    if (!verification.verified) return reject('signature not verified');

    // Moving the counter forward is what lets a cloned authenticator be noticed (the library already
    // refused a counter that went backwards); synced passkeys keep it at 0 and are exempt.
    await this.prisma.credential.update({
      where: { id: stored.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), backedUp: verification.authenticationInfo.credentialBackedUp, lastUsedAt: new Date() },
    });
    this.logger.log(`"${stored.user.username}" signed in with a passkey`);
    const session = await this.auth.createSession(stored.userId, meta);
    const user = await this.auth.principalUser(stored.userId);
    return { user, session };
  }

  /** Reads and deletes a challenge in one step; null-equivalent errors for missing, wrong-purpose and expired ones. */
  private async takeChallenge(id: string, purpose: string): Promise<string> {
    const row = await this.prisma.authChallenge.findUnique({ where: { id } });
    const { count } = await this.prisma.authChallenge.deleteMany({ where: { id } });
    if (!row || count !== 1 || row.purpose !== purpose || !row.challenge || row.expiresAt <= new Date()) {
      throw new BadRequestException('That request expired; start again');
    }
    return row.challenge;
  }
}

function toSummary(c: { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: Date; lastUsedAt: Date | null }): PasskeySummaryDto {
  return { id: c.id, name: c.name, deviceType: c.deviceType, backedUp: c.backedUp, createdAtMs: c.createdAt.getTime(), lastUsedAtMs: c.lastUsedAt?.getTime() ?? null };
}
