import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // esbuild drops the decorator metadata Nest's constructor injection reads; same SWC setup as tsup.config.ts.
  plugins: [swc.vite({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
  // Same portable core entry the production bundle uses (see tsup.config.ts).
  resolve: { alias: { '@beatseam/core': path.resolve(dirname, '../../packages/core/src/server.ts') } },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // One shared Postgres database: files run serially so they don't truncate each other's rows.
    fileParallelism: false,
  },
});
