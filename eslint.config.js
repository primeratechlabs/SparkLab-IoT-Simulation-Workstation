import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'fixtures/generated/**',
      'packages/app/public/toolchain/**',
      'packages/app/public/c3-toolchain/**',
      'packages/app/public/esp32-classic-toolchain/**',
      'ci/**/build/**', // vendored LLVM/emscripten/emsdk source trees ([CI/HUMAN], gitignored)
      'ci/**/wasm-out/**',
      'docs/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Vue SFCs were not linted at all (AUD-026). The 'essential' set is the correctness baseline (parse
  // errors, unused/undefined components, malformed templates); `<script lang="ts">` is delegated to the
  // TS parser so the script body is type-aware too.
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
    // TypeScript (vue-tsc) resolves identifiers in the SFC script, so `no-undef` is redundant and would
    // false-flag every DOM/browser global — disabled here exactly as typescript-eslint does for .ts.
    rules: { 'no-undef': 'off' },
  },
  {
    // Node scripts (fixture generators, tooling) run under Node, not the browser.
    files: ['**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  {
    // Shipped library/app source must not carry stray debug output. `no-debugger` hard-fails; `no-console`
    // only warns and allows warn/error (genuine diagnostics: the asset-integrity warning + the worker /
    // cross-origin-isolation error logs). Scoped to src; tests/scripts/workers log freely by design.
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.vue'],
    ignores: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-debugger': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
