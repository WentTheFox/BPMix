import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Request-body size limit. Express's 100KB default would reject a legitimate batch of queued
 * changes (one playback state alone, with a long shuffle order, can pass it) before the per-item
 * limits in @bpmix/api get a say; those, not this, are the real rules. This is the outer fence.
 */
export const JSON_BODY_LIMIT = '2mb';

/** Settings every instance of the app needs, whether it is started by main.ts or by a test. */
export function configureHttp(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}
