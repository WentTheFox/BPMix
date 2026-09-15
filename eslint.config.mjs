// @ts-check
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Every RN/web component or hook file in the app - core has none of these
// (no React dependency at all), so it's left out of the react/react-hooks
// block below and only gets the plain typescript-eslint rules.
const REACT_GLOBS = ['apps/web/**/*.{ts,tsx}', 'apps/mobile/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      // Native project directories - generated/vendored code this repo
      // doesn't author by hand (Gradle/CMake output, the checked-in
      // Windows C++/WinRT project, Xcode-style build artifacts).
      'apps/mobile/android/**',
      'apps/mobile/windows/**',
      'apps/mobile/ios/**',
      // Regenerated before every dev/build/start/typecheck (see
      // scripts/generate-build-info.mjs) - not hand-authored, no point
      // linting whatever the last build happened to stamp into it.
      'packages/core/src/buildInfo.ts',
    ],
  },
  {
    // typescript-eslint's own recommended config has no `files` restriction
    // of its own (see its `base`/`recommended` blocks) - without scoping it
    // here, the TS parser and TS-specific rules (like no-require-imports)
    // were being applied to plain CommonJS config files too
    // (metro.config.js, jest.config.windows.js), which legitimately use
    // require()/module.exports and were never meant to be linted as TS.
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      // TypeScript itself already reports a reference to an undeclared
      // name (and understands ambient/global types this plugin doesn't) -
      // see typescript-eslint's own docs recommending this be turned off
      // wherever the TS-aware rules are in play.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: REACT_GLOBS,
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: '19.2' } },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      // Deliberately just the classic pair (not
      // reactHooks.configs.flat.recommended, which as of v7 also bundles a
      // large set of React Compiler readiness rules - purity/refs/
      // immutability/set-state-in-effect checks aimed at codebases opting
      // into the compiler). Tried that broader set first: it flagged
      // several already-deliberate, already-documented patterns in this
      // codebase as errors (Date.now() in a throttle gate, a ref mutated
      // outside render, persistPlaybackPatch referenced before its later
      // `const` in the same closure) rather than real bugs - too much
      // noise for what "recommended rules... to catch some potential bugs"
      // is after here. rules-of-hooks/exhaustive-deps are the two rules
      // this plugin has been known as "recommended" for since well before
      // v7's compiler-rule bundle existed.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // TypeScript already enforces prop shapes at every call site - this
      // rule only knows about React.PropTypes, not TS types, and would
      // otherwise flag every single component in the project.
      'react/prop-types': 'off',
      // Every component here is a named function declaration/expression
      // already (CLAUDE.md's "single component per .tsx file" convention),
      // not an anonymous one this rule exists to catch in a stack trace/
      // React DevTools.
      'react/display-name': 'off',
    },
  },
  {
    // RN's global injected by Metro/the native runtime (guards dev-only
    // code, e.g. MemoryOverlay) - not a real undeclared reference.
    files: ['apps/mobile/**/*.{ts,tsx}'],
    languageOptions: { globals: { __DEV__: 'readonly' } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
);
