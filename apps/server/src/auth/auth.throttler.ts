import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Sign-in attempts per minute per address and username (BEATSEAM_AUTH_RATE_LIMIT, default 10). Read per request so tests can lower it. */
export const authRateLimit = () => Number(process.env.BEATSEAM_AUTH_RATE_LIMIT ?? 10);

/** Counts by address *and* the username in the body, so one account can't be hammered from many places unnoticed, nor one address lock out everyone. */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const username = (req.body as { username?: unknown } | undefined)?.username;
    return `${String(req.ip)}|${typeof username === 'string' ? username.trim().toLowerCase() : ''}`;
  }
}
