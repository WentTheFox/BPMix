import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` (build/typecheck) doesn't connect, so don't demand a URL
  // there; migrate commands do connect and fail clearly on the empty fallback.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
