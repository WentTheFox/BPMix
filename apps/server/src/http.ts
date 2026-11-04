import { API_VERSION_HEADER, API_VERSION_UNSUPPORTED_CODE, API_VERSIONS_HEADER, SUPPORTED_API_VERSIONS } from '@beatseam/api';
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
  // Tell every client which API versions this server speaks, and turn away one that speaks a version it doesn't, so a
  // breaking change reaches an out-of-date app as a clear "update the app" instead of a confusing parse failure.
  // A request with no version header (a browser opening a page, an <audio> element) is let through: only apps that
  // name a version can be told to update.
  app.use((req: { path: string; headers: Record<string, string | string[] | undefined> }, res: { setHeader(name: string, value: string): void; status(code: number): { json(body: unknown): void } }, next: () => void) => {
    if (!req.path.startsWith('/api/v1')) return next();
    res.setHeader(API_VERSIONS_HEADER, SUPPORTED_API_VERSIONS.join(','));
    const sent = req.headers[API_VERSION_HEADER.toLowerCase()];
    const raw = Array.isArray(sent) ? sent[0] : sent;
    if (raw === undefined || SUPPORTED_API_VERSIONS.includes(Number(raw))) return next();
    const newest = Math.max(...SUPPORTED_API_VERSIONS);
    const appIsOlder = Number(raw) < newest;
    res.status(426).json({
      statusCode: 426,
      code: API_VERSION_UNSUPPORTED_CODE,
      message: appIsOlder
        ? `This server needs a newer version of the app (the app speaks API version ${raw}; the server speaks ${SUPPORTED_API_VERSIONS.join(', ')}). Update the app to keep using it.`
        : `This server is older than the app (the app speaks API version ${raw}; the server speaks ${SUPPORTED_API_VERSIONS.join(', ')}). Update the server, or use an older version of the app.`,
      supportedVersions: SUPPORTED_API_VERSIONS,
    });
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
