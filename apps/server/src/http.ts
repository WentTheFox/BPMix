import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Request-body size limit. Express's 100KB default would reject a legitimate batch of queued
 * changes (one playback state alone, with a long shuffle order, can pass it) before the per-item
 * limits in @bpmix/api get a say; those, not this, are the real rules. This is the outer fence.
 */
export const JSON_BODY_LIMIT = '2mb';

/** Settings every instance of the app needs, whether it is started by main.ts or by a test. */
export function configureHttp(app: NestExpressApplication): void {
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
