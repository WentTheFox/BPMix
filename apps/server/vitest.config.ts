import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // One shared Postgres database: files run serially so they don't truncate each other's rows.
    fileParallelism: false,
  },
});
