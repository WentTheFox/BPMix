import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  deviceApproveRequestSchema,
  deviceCodeRequestSchema,
  deviceWaitRequestSchema,
  passkeyLoginVerifyRequestSchema,
  passkeyRegisterVerifyRequestSchema,
  passkeyRenameRequestSchema,
  passwordLoginRequestSchema,
  redeemInviteRequestSchema,
  setPasswordRequestSchema,
  setupRequestSchema,
  totpCodeRequestSchema,
  totpLoginRequestSchema,
  type AuthStatusDto,
  type LoginResultDto,
  type DeviceCodeResultDto,
  type DeviceLookupDto,
  type DeviceTokenSummaryDto,
  type DeviceWaitResultDto,
  type MeDto,
  type PasskeyLoginOptionsDto,
  type PasskeySummaryDto,
  type SessionSummaryDto,
  type TotpSetupDto,
} from '@beatseam/api';
import { parseInput } from '../common/zod.js';
import { AuthConfig } from './auth.config.js';
import { AuthService, type IssuedSession, type RequestMeta } from './auth.service.js';
import { DeviceService } from './device.service.js';
import { PasskeyService } from './passkey.service.js';
import { authRateLimit } from './auth.throttler.js';
import { SESSION_COOKIE } from './cookies.js';
import { AllowUnenrolled, CurrentPrincipal, DeviceAccessible, Public, type AuthedRequest, type Principal, type PrincipalUser } from './principal.js';

const attempts = () => ({ default: { limit: authRateLimit, ttl: 60_000 } });

function metaOf(req: AuthedRequest): RequestMeta {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passkeys: PasskeyService,
    private readonly devices: DeviceService,
    private readonly config: AuthConfig,
  ) {}

  private startSession(req: AuthedRequest, res: Response, session: IssuedSession): void {
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies(req),
      path: '/',
      expires: session.expiresAt,
    });
  }

  /** The state a browser reaches after signing in: who it is, as /auth/me would say. */
  private signedIn(req: AuthedRequest, res: Response, user: PrincipalUser, session: IssuedSession): Promise<MeDto> {
    this.startSession(req, res, session);
    return this.auth.me({ kind: 'session', user, authenticatedAt: new Date() });
  }

  @Public()
  @Get('status')
  status(): Promise<AuthStatusDto> {
    return this.auth.status();
  }

  /** The one open sign-up: only works while no account is set up yet, and makes an admin. */
  @Public()
  @Throttle(attempts())
  @Post('setup')
  async setup(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<MeDto> {
    const { user, session } = await this.auth.setupFirstAdmin(parseInput(setupRequestSchema, body), metaOf(req));
    return this.signedIn(req, res, user, session);
  }

  /** Opens an enrollment link an admin created; signs in just far enough to set up passkeys/password+TOTP. */
  @Public()
  @Throttle(attempts())
  @HttpCode(200)
  @Post('invites/redeem')
  async redeem(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<MeDto> {
    const { user, session } = await this.auth.redeemInvite(parseInput(redeemInviteRequestSchema, body).inviteToken, metaOf(req));
    return this.signedIn(req, res, user, session);
  }

  @Public()
  @Throttle(attempts())
  @HttpCode(200)
  @Post('login/password')
  async loginPassword(@Body() body: unknown, @Req() req: AuthedRequest): Promise<LoginResultDto> {
    const { username, password } = parseInput(passwordLoginRequestSchema, body);
    const { mfaToken } = await this.auth.loginWithPassword(username, password, metaOf(req));
    return { status: 'mfa_required', mfaToken };
  }

  @Public()
  @Throttle(attempts())
  @HttpCode(200)
  @Post('login/totp')
  async loginTotp(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<LoginResultDto> {
    const { mfaToken, code, recoveryCode } = parseInput(totpLoginRequestSchema, body);
    const { user, session } = await this.auth.completeMfa(mfaToken, { code, recoveryCode }, metaOf(req));
    return { status: 'ok', me: await this.signedIn(req, res, user, session) };
  }

  /** Step 1 of passkey sign-in. Usernameless: the device offers whichever passkeys it holds for this site. */
  @Public()
  @Throttle(attempts())
  @HttpCode(200)
  @Post('login/passkey/options')
  passkeyLoginOptions(@Req() req: AuthedRequest): Promise<PasskeyLoginOptionsDto> {
    return this.passkeys.authenticationOptions(req);
  }

  @Public()
  @Throttle(attempts())
  @HttpCode(200)
  @Post('login/passkey/verify')
  async passkeyLoginVerify(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<MeDto> {
    const { challengeId, response } = parseInput(passkeyLoginVerifyRequestSchema, body);
    const { user, session } = await this.passkeys.verifyAuthentication(challengeId, response, req, metaOf(req));
    return this.signedIn(req, res, user, session);
  }

  // ---- Native apps: sign in by getting a code approved in a browser.

  /** The app asks for a code to show the user. */
  @Public()
  @Throttle(attempts())
  @Post('device/code')
  deviceCode(@Body() body: unknown, @Req() req: AuthedRequest): Promise<DeviceCodeResultDto> {
    return this.devices.requestCode(parseInput(deviceCodeRequestSchema, body).deviceName, req);
  }

  /** The app waits here. Held open until the user decides (or ~25s, then 'pending' and the app asks again). */
  @Public()
  @Throttle({ default: { limit: () => authRateLimit() * 12, ttl: 60_000 } })
  @HttpCode(200)
  @Post('device/wait')
  deviceWait(@Body() body: unknown): Promise<DeviceWaitResultDto> {
    return this.devices.wait(parseInput(deviceWaitRequestSchema, body).deviceCode);
  }

  /** The browser shows which device is asking before the user approves it. */
  @Throttle(attempts())
  @Get('device/lookup')
  deviceLookup(@Query('userCode') userCode?: string): Promise<DeviceLookupDto> {
    return this.devices.lookup(userCode ?? '');
  }

  @Throttle(attempts())
  @HttpCode(204)
  @Post('device/approve')
  async deviceApprove(@Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<void> {
    this.auth.requireFreshAuth(principal);
    const { userCode, approve } = parseInput(deviceApproveRequestSchema, body);
    await this.devices.decide(userCode, approve, principal.user.id);
  }

  @Get('devices')
  devicesList(@CurrentPrincipal() principal: Principal): Promise<DeviceTokenSummaryDto[]> {
    return this.devices.listTokens(principal.user.id);
  }

  @HttpCode(204)
  @Delete('devices/:id')
  async deviceRevoke(@Param('id') id: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.devices.revokeToken(principal.user.id, id);
  }

  @AllowUnenrolled()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @CurrentPrincipal() principal: Principal): Promise<void> {
    if (principal.sessionId) await this.auth.revokeSession(principal.user.id, principal.sessionId).catch(() => undefined);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @AllowUnenrolled()
  @DeviceAccessible()
  @Get('me')
  me(@CurrentPrincipal() principal: Principal): Promise<MeDto> {
    return this.auth.me(principal);
  }

  /** A native app signing itself out: revokes the very token it is calling with, so it stops working server-side too. */
  @DeviceAccessible()
  @HttpCode(204)
  @Delete('me/token')
  async revokeOwnToken(@CurrentPrincipal() principal: Principal): Promise<void> {
    if (principal.kind !== 'device' || !principal.deviceTokenId) throw new BadRequestException('Only an app signed in with a device token can sign itself out this way');
    await this.devices.revokeToken(principal.user.id, principal.deviceTokenId);
  }

  @AllowUnenrolled()
  @HttpCode(204)
  @Post('password')
  async setPassword(@Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<void> {
    this.auth.requireFreshAuth(principal);
    await this.auth.setPassword(principal.user.id, parseInput(setPasswordRequestSchema, body).password);
    await this.auth.revokeOtherSessions(principal.user.id, principal.sessionId);
  }

  @AllowUnenrolled()
  @Post('totp/begin')
  beginTotp(@CurrentPrincipal() principal: Principal): Promise<TotpSetupDto> {
    this.auth.requireFreshAuth(principal);
    return this.auth.beginTotp(principal.user.id);
  }

  @AllowUnenrolled()
  @Post('totp/enable')
  enableTotp(@Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<{ recoveryCodes: string[] }> {
    this.auth.requireFreshAuth(principal);
    return this.auth.enableTotp(principal.user.id, parseInput(totpCodeRequestSchema, body).code);
  }

  @HttpCode(204)
  @Post('totp/disable')
  async disableTotp(@Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<void> {
    this.auth.requireFreshAuth(principal);
    await this.auth.disableTotp(principal.user.id, parseInput(totpCodeRequestSchema, body).code);
    await this.auth.revokeOtherSessions(principal.user.id, principal.sessionId);
  }

  /** Replaces all recovery codes with a new set, shown once. */
  @AllowUnenrolled()
  @Post('recovery-codes')
  async regenerateRecoveryCodes(@CurrentPrincipal() principal: Principal): Promise<{ recoveryCodes: string[] }> {
    this.auth.requireFreshAuth(principal);
    const recoveryCodes = await this.auth.replaceRecoveryCodes(principal.user.id);
    await this.auth.revokeOtherSessions(principal.user.id, principal.sessionId);
    return { recoveryCodes };
  }

  @AllowUnenrolled()
  @HttpCode(200)
  @Post('passkeys/register/options')
  passkeyRegisterOptions(@Req() req: AuthedRequest, @CurrentPrincipal() principal: Principal): Promise<Record<string, unknown>> {
    this.auth.requireFreshAuth(principal);
    return this.passkeys.registrationOptions(principal.user.id, req);
  }

  @AllowUnenrolled()
  @Post('passkeys/register/verify')
  passkeyRegisterVerify(@Body() body: unknown, @Req() req: AuthedRequest, @CurrentPrincipal() principal: Principal): Promise<PasskeySummaryDto> {
    this.auth.requireFreshAuth(principal);
    const { response, name } = parseInput(passkeyRegisterVerifyRequestSchema, body);
    return this.passkeys.verifyRegistration(principal.user.id, response, name, req);
  }

  @Patch('passkeys/:id')
  renamePasskey(@Param('id') id: string, @Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<PasskeySummaryDto> {
    return this.passkeys.rename(principal.user.id, id, parseInput(passkeyRenameRequestSchema, body).name);
  }

  @HttpCode(204)
  @Delete('passkeys/:id')
  async removePasskey(@Param('id') id: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    this.auth.requireFreshAuth(principal);
    await this.passkeys.remove(principal.user.id, id);
    await this.auth.revokeOtherSessions(principal.user.id, principal.sessionId);
  }

  @Get('sessions')
  sessions(@CurrentPrincipal() principal: Principal): Promise<SessionSummaryDto[]> {
    return this.auth.listSessions(principal.user.id, principal.sessionId);
  }

  @HttpCode(204)
  @Delete('sessions/:id')
  async revokeSession(@Param('id') id: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.auth.revokeSession(principal.user.id, id);
  }
}
