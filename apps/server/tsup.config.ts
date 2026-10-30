import { defineConfig } from 'tsup';
import swc from 'unplugin-swc';

// tsc can't emit this server: @bpmix/core is raw extensionless TypeScript that
// Node ESM can't load, and Nest needs decorator metadata, which plain esbuild
// doesn't emit. So SWC (via unplugin-swc) compiles everything, and core is
// bundled in while the real npm dependencies stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@bpmix/core'],
  esbuildPlugins: [swc.esbuild({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
});
