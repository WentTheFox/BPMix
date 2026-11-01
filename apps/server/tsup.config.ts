import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Options } from 'tsup';
import swc from 'unplugin-swc';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// unplugin-swc loads files into its own `swc:` namespace, which has no resolve
// directory, so bare imports inside them (core's jsmediatags, ...) can't be
// found. Re-resolve those from the importing file's real directory.
const resolveFromImporter: NonNullable<Options['esbuildPlugins']>[number] = {
  name: 'resolve-from-importer',
  setup(build) {
    build.onResolve({ filter: /^[^./]/, namespace: 'swc' }, (args) => {
      if (args.pluginData?.fromImporter) return undefined;
      return build.resolve(args.path, {
        resolveDir: path.dirname(args.importer.replace(/^swc:/, '')),
        kind: args.kind,
        pluginData: { fromImporter: true },
      });
    });
  },
};

// tsc can't emit this server: @beatseam/core is raw extensionless TypeScript that
// Node ESM can't load, and Nest needs decorator metadata, which plain esbuild
// doesn't emit. So SWC (via unplugin-swc) compiles everything, and core is
// bundled in (through its portable server.ts entry, not the full index) while
// the real npm dependencies stay external.
export default defineConfig({
  entry: ['src/main.ts', 'src/scanner/analysisWorker.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@beatseam/core', '@beatseam/api'],
  esbuildOptions(options) {
    options.alias = { ...options.alias, '@beatseam/core': path.resolve(dirname, '../../packages/core/src/server.ts') };
  },
  esbuildPlugins: [
    resolveFromImporter,
    swc.esbuild({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } }),
  ],
});
