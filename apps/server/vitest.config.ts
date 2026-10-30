import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Same portable core entry the production bundle uses (see tsup.config.ts).
  resolve: { alias: { '@bpmix/core': path.resolve(dirname, '../../packages/core/src/server.ts') } },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // One shared Postgres database: files run serially so they don't truncate each other's rows.
    fileParallelism: false,
  },
});
