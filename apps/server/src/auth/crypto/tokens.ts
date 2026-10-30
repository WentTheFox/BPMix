import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random URL-safe secret (session cookie, device token, invite link, device code). 256 bits by default. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are high-entropy random strings, so a plain SHA-256 is enough to store
 * them (no salt or slow hash needed) - a leaked table can't be turned back into
 * a usable token.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
