# Builds and serves the BPMix web app, plus (optionally) a small backend
# that exposes a Docker-mounted music library to it - see apps/server.
#
#   docker build -t bpmix .
#   docker run -p 8080:8080 -v ~/Music:/music/MyLibrary bpmix

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /repo

# Install first with only manifests + lockfile so this layer is cached
# whenever source changes but dependencies don't.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/ui/package.json packages/ui/package.json
# --filter scopes this to @bpmix/web + @bpmix/server and their actual
# dependencies - apps/mobile's package.json is still present for correct
# workspace resolution against the lockfile, but its own dependencies
# (react-native, and transitively sqlite3 - a native module needing a
# node-gyp compile) are never installed. That compile was crashing QEMU
# outright under arm64 emulation ("qemu core dumped") during a cross-arch
# CI build - this image never runs apps/mobile, so there was never a
# reason to pay that cost (or carry that native-toolchain fragility) here.
RUN pnpm install --frozen-lockfile --filter @bpmix/web... --filter @bpmix/server...

COPY . .
RUN pnpm --filter @bpmix/web build
RUN pnpm --filter @bpmix/server build
# Trims apps/server/node_modules down to its own production dependencies
# (still symlinked to the shared pnpm store, so this is cheap).
RUN pnpm --filter @bpmix/server deploy --prod /out/server
RUN cp -r apps/web/dist /out/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV BPMIX_LIBRARY_ROOT=/music
ENV BPMIX_WEB_DIST=/app/web
COPY --from=build /out/server ./
COPY --from=build /out/web ./web
VOLUME ["/music"]
EXPOSE 8080
CMD ["node", "dist/index.js"]
