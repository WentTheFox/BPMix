import { createHmac, randomBytes } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.replace(/[\s=-]/g, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, base32-encoded (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP over HMAC-SHA1. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

export function totpStep(timeMs: number): number {
  return Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Checks a code against the current time step and one step either side (clock
 * drift). Returns the step that matched, or null. Callers store the step and
 * reject anything at or below it afterwards, so a code can't be used twice.
 */
export function verifyTotp(base32Secret: string, code: string, timeMs = Date.now(), lastUsedStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(base32Secret);
  const current = totpStep(timeMs);
  for (const step of [current, current - 1, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

/** The otpauth:// URI authenticator apps import (usually via a QR code of it). */
export function totpUri(options: { secret: string; accountName: string; issuer: string }): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.accountName)}`;
  const params = new URLSearchParams({ secret: options.secret, issuer: options.issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
