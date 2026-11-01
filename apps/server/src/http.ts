import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Request-body size limit. Express's 100KB default would reject a legitimate batch of queued
 * changes (one playback state alone, with a long shuffle order, can pass it) before the per-item
 * limits in @beatseam/api get a say; those, not this, are the real rules. This is the outer fence.
 */
export const JSON_BODY_LIMIT = '2mb';

/** Settings every instance of the app needs, whether it is started by main.ts or by a test. */
export function configureHttp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  // The account pages add their own strict CSP on top of this (pages.controller.ts); these cover the API and the web app.
  app.use((req: { secure?: boolean; path: string }, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // Only once the connection is known to be https (req.secure honours BEATSEAM_TRUST_PROXY); on plain http it would be ignored anyway.
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    // Sign-in responses carry who someone is and tokens; no cache or proxy should keep them.
    if (req.path.startsWith('/api/v1/auth')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Postgres cannot store or compare a NUL character in text, so one anywhere in a request would
  // surface as a 500 from deep inside a query. Refuse it up front, everywhere, instead.
  app.use((req: { url: string }, res: { status(code: number): { json(body: unknown): void } }, next: () => void) => {
    if (/%00/i.test(req.url)) res.status(400).json({ statusCode: 400, message: 'Null characters are not allowed' });
    else next();
  });
  app.useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
    // JSON spells a NUL as the six characters \u0000.
    // body-parser turns whatever this throws into the response, using the error's `status`.
    verify: (_req: unknown, _res: unknown, body: Buffer) => {
      if (body.includes('\\u0000')) throw Object.assign(new Error('Null characters are not allowed'), { status: 400 });
    },
  });
}
