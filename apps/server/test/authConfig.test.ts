import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AuthConfig } from '../src/auth/auth.config.js';

const config = (origins: string) => new AuthConfig(new ConfigService({ BEATSEAM_ORIGIN: origins }));
const request = (headers: Record<string, string>): Request =>
  ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), protocol: 'http', get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

describe('AuthConfig with several public origins', () => {
  const c = config('https://a.example.com, https://b.example.org/');

  it('uses the origin the request came from for the passkey RP ID and cookies', () => {
    const req = request({ origin: 'https://b.example.org' });
    expect(c.rpId(req)).toBe('b.example.org');
    expect(c.secureCookies(req)).toBe(true);
  });

  it('falls back to the Host / X-Forwarded-Host header when there is no Origin', () => {
    expect(c.rpId(request({ host: 'b.example.org' }))).toBe('b.example.org');
    expect(c.rpId(request({ host: 'internal:3000', 'x-forwarded-host': 'b.example.org' }))).toBe('b.example.org');
  });

  it('uses the first origin when nothing matches, and never an unlisted one', () => {
    expect(c.rpId(request({ host: 'other.example.net' }))).toBe('a.example.com');
    expect(c.rpId(request({ origin: 'https://evil.example' }))).toBe('a.example.com');
  });
});
