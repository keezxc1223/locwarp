// ESLint v9 flat config — pairs with tsc.
// Runs as:  npm run lint            (check)
//           npm run lint -- --fix   (auto-fix)
//
// Philosophy: keep tsc as the source of truth for type errors; ESLint's job is
// only to catch React/hook patterns and code-smell categories tsc doesn't flag.
import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        // Vite pulls process.env at build time
        process: 'readonly',
        // Electron preload bridge
        require: 'readonly',
        module: 'readonly',
        // React 18 JSX namespace (used in legacy ReactNode-style return types)
        JSX: 'readonly',
        // DOM types — exist in TS lib but ESLint's no-undef can't see lib.d.ts
        RequestInit: 'readonly',
        BodyInit: 'readonly',
        HeadersInit: 'readonly',
        ResponseInit: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // React hook safety — most valuable rules ESLint adds beyond tsc.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // HMR boundary — components must be the only export per file.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Stage 1/2 explicitly removed all `catch (err: any)` — keep it that way.
      '@typescript-eslint/no-explicit-any': 'warn',
      // tsc already enforces noUnusedLocals; this rule is a redundant safety net
      // tuned to allow `_` prefix for intentional ignores.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Disable base rule in favor of TS version above
      'no-unused-vars': 'off',

      // Common bug patterns
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'prefer-const': 'error',
      'eqeqeq': ['error', 'smart'],
    },
  },
  {
    // Build artifacts and config files don't need linting.
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      'electron/**',
      '*.config.js',
      '*.config.ts',
      'public/**',
      'scripts/**',
    ],
  },
]
