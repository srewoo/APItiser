import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

const tsRules = {
  ...tsPlugin.configs.recommended.rules,
  // TypeScript's own compiler resolves identifiers and type-only references
  // (RequestInit, HeadersInit, DOMException, ...). Leaving no-undef on produces
  // false positives on type references, so typescript-eslint recommends disabling it.
  'no-undef': 'off',
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
  'no-console': ['warn', { allow: ['warn', 'error'] }],
  'prefer-const': 'error',
  'no-var': 'error'
};

const tsLanguageOptions = {
  parser: tsParser,
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true }
  }
};

export default [
  {
    ignores: ['dist/', 'node_modules/', '*.js', '*.d.ts']
  },
  js.configs.recommended,
  {
    // Extension source: runs in browser (popup/sidepanel) + service worker contexts.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ...tsLanguageOptions,
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        chrome: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: tsRules
  },
  {
    // Tests: run under Vitest in a node environment with Vitest globals enabled.
    files: ['tests/**/*.ts'],
    languageOptions: {
      ...tsLanguageOptions,
      globals: {
        ...globals.node,
        ...globals.browser,
        chrome: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: tsRules
  },
  prettierConfig
];
