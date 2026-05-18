// @ts-check
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');
const prettier = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const sonarjs = require('eslint-plugin-sonarjs');
const unusedImports = require('eslint-plugin-unused-imports');

const recommendedConfig = tseslint.configs['flat/recommended'];

module.exports = [
  ...(Array.isArray(recommendedConfig)
    ? recommendedConfig
    : [recommendedConfig]),
  {
    // Override the problematic rule before it's applied
    rules: {
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettier,
      sonarjs: sonarjs,
      'unused-imports': unusedImports,
    },
    rules: {
      ...prettierConfig.rules,
      // Disable base ESLint rule in favor of TypeScript ESLint version
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': [
        'error',
        {
          allowShortCircuit: false,
          allowTernary: false,
          allowTaggedTemplates: false,
        },
      ],
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'unused-imports/no-unused-imports': 'error',
      'max-lines': [
        'error',
        { max: 1000, skipBlankLines: true, skipComments: true },
      ],
      complexity: ['error', 10],
      'max-lines-per-function': [
        'error',
        { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-collapsible-if': 'error',
      'sonarjs/no-redundant-jump': 'error',
      'sonarjs/no-small-switch': 'error',
    },
  },
  {
    files: ['src/**/*.spec.ts'],
    rules: {
      complexity: 'off',
      'max-lines-per-function': 'off',
      'max-depth': 'off',
      'max-params': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/no-collapsible-if': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettierConfig,
  {
    ignores: [
      'commitlint.config.mjs',
      'dist/**',
      'node_modules/**',
      'coverage/**',
    ],
  },
];
