import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/crypto/password.js';
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from '../../src/auth/crypto/recoveryCodes.js';
import { loadSecretKey, SecretBox } from '../../src/auth/crypto/secretBox.js';
import { constantTimeEquals, generateToken, hashToken } from '../../src/auth/crypto/tokens.js';
import { base32Decode, base32Encode, generateTotpSecret, hotp, totpStep, totpUri, verifyTotp } from '../../src/auth/crypto/totp.js';

describe('tokens', () => {
  it('generates unique url-safe tokens and stores only their hash', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(`${a}x`));
  });

  it('compares in constant time without throwing on different lengths', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });
});

describe('passwords', () => {
  it('verifies the right password only, and survives a malformed hash', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse battery stapl')).toBe(false);
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
  });
});

describe('totp', () => {
  // RFC 6238 appendix B (SHA-1, secret "12345678901234567890"); the RFC lists 8 digits, these are the low 6.
  const secret = Buffer.from('12345678901234567890');
  const vectors: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  it.each(vectors)('matches the RFC 6238 vector at t=%i', (seconds, expected) => {
    expect(hotp(secret, totpStep(seconds * 1000))).toBe(expected);
  });

  it('round-trips base32', () => {
    expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(secret)).toBe(true);
    const generated = generateTotpSecret();
    expect(generated).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(generated)).toHaveLength(20);
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it('accepts the current and adjacent steps, rejects others, and refuses a replayed step', () => {
    const base32 = base32Encode(secret);
    const now = 1111111111 * 1000;
    expect(verifyTotp(base32, '050471', now)).toBe(totpStep(now));
    expect(verifyTotp(base32, '081804', now)).toBe(totpStep(now) - 1); // previous step: clock drift
    expect(verifyTotp(base32, '287082', now)).toBeNull(); // far away
    expect(verifyTotp(base32, '12345', now)).toBeNull();
    expect(verifyTotp(base32, 'abcdef', now)).toBeNull();
    // Replay: once step N has been used, N and earlier are refused.
    expect(verifyTotp(base32, '050471', now, totpStep(now))).toBeNull();
    expect(verifyTotp(base32, '081804', now, totpStep(now))).toBeNull();
  });

  it('builds an otpauth uri', () => {
    const uri = new URL(totpUri({ secret: 'ABC234', accountName: 'ann@example.com', issuer: 'Beatseam' }));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Beatseam:ann@example.com');
    expect(uri.searchParams.get('secret')).toBe('ABC234');
    expect(uri.searchParams.get('issuer')).toBe('Beatseam');
  });
});

describe('recovery codes', () => {
  it('generates distinct, readable codes that match however they are typed', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    const code = codes[0]!;
    expect(normalizeRecoveryCode(code.toLowerCase().replace('-', ' '))).toBe(normalizeRecoveryCode(code));
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(code)).not.toBe(hashRecoveryCode(codes[1]!));
  });
});

describe('secret box', () => {
  it('seals and opens, with a fresh iv each time', () => {
    const box = new SecretBox('server secret');
    const sealed = box.seal('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(box.seal('JBSWY3DPEHPK3PXP')).not.toBe(sealed);
  });

  it('rejects tampering and the wrong key', () => {
    const sealed = new SecretBox('one').seal('secret');
    expect(() => new SecretBox('two').open(sealed)).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('forged!').toString('base64url');
    expect(() => new SecretBox('one').open(parts.join('.'))).toThrow();
    expect(() => new SecretBox('one').open('garbage')).toThrow();
  });

  it('uses the configured key, else creates one key file and keeps reusing it', async () => {
    expect(await loadSecretKey('from-env', '/nonexistent')).toBe('from-env');
    const dir = await mkdtemp(path.join(tmpdir(), 'beatseam-key-'));
    try {
      const first = await loadSecretKey(undefined, path.join(dir, 'data'));
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(await loadSecretKey(undefined, path.join(dir, 'data'))).toBe(first);
      expect((await stat(path.join(dir, 'data', 'secret.key'))).mode & 0o777).toBe(0o600);
      expect((await readFile(path.join(dir, 'data', 'secret.key'), 'utf8')).trim()).toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
