import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Auth settings, read once from the environment. */
@Injectable()
export class AuthConfig {
  private readonly logger = new Logger(AuthConfig.name);
  private warnedAboutDerivedOrigin = false;

  /** Origins the web app is served from (BEATSEAM_ORIGIN, comma-separated), e.g. https://music.example.com. */
  readonly origins: string[];
  readonly rpName = 'Beatseam';
  /** If set, the very first sign-up must present it, so nobody can race the owner to a freshly deployed public server. */
  readonly setupToken: string | undefined;
  /** BEATSEAM_SETUP_TOKEN=none: anyone may make the first account (no generated token either). For a server on a private network. */
  readonly openSetup: boolean;
  readonly sessionTtlMs = 30 * DAY_MS;
  readonly mfaTtlMs = 5 * 60_000;
  readonly inviteTtlMs = 7 * DAY_MS;
  /** How recently a session must have signed in to change credentials or manage users. */
  readonly freshAuthMs = 10 * 60_000;
  /** A session is cut off this long after it was created, however actively it has been used (the sliding window alone would never end). */
  readonly sessionMaxAgeMs = 90 * DAY_MS;
  readonly maxMfaAttempts = 5;
  /** Failed password / second-factor sign-ins tolerated per account, and per address, inside failureWindowMs. */
  readonly maxFailuresPerAccount = 20;
  readonly maxFailuresPerAddress = 100;
  readonly failureWindowMs = 15 * 60_000;
  /** How long a first sign-up has to finish enrolling before another visitor may replace the unfinished account. */
  readonly setupGraceMs = 15 * 60_000;
  /** How long a native app has to get its sign-in code approved. */
  readonly deviceCodeTtlMs = 10 * 60_000;
  /** A device token unused for this long stops working (it's re-issued by signing in again). */
  readonly deviceTokenIdleMs = 180 * DAY_MS;
  /** How long one 'wait for approval' request is held open before answering 'pending'. */
  readonly deviceWaitMs: number;

  constructor(config: ConfigService) {
    this.origins = (config.get<string>('BEATSEAM_ORIGIN') ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter((o) => o.length > 0);
    const setup = config.get<string>('BEATSEAM_SETUP_TOKEN') || undefined;
    this.openSetup = setup?.toLowerCase() === 'none';
    this.setupToken = this.openSetup ? undefined : setup;
    this.deviceWaitMs = Number(config.get('BEATSEAM_DEVICE_WAIT_MS') ?? 25_000);
  }

  /** The origins a request may legitimately come from: the configured ones, else the one it was addressed to. */
  allowedOrigins(req: Request): string[] {
    if (this.origins.length > 0) return this.origins;
    if (!this.warnedAboutDerivedOrigin) {
      this.warnedAboutDerivedOrigin = true;
      this.logger.warn('BEATSEAM_ORIGIN is not set; trusting the request\'s own host. Set it (e.g. https://music.example.com) for passkeys and CSRF checks to be reliable.');
    }
    return [`${req.protocol}://${req.get('host') ?? 'localhost'}`];
  }

  rpId(req: Request): string {
    return new URL(this.allowedOrigins(req)[0]!).hostname;
  }

  /** Cookies are Secure whenever the site is served over https. */
  secureCookies(req: Request): boolean {
    return this.allowedOrigins(req)[0]!.startsWith('https://');
  }
}
