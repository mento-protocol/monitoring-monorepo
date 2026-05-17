import js from "@eslint/js";
import unusedImports from "eslint-plugin-unused-imports";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
  })),
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { tsconfigRootDir: __dirname },
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Envio handler/context types still expose dynamic entity and effect
      // surfaces. Keep type-aware control-flow rules on while staging the
      // noisy unsafe-* checks separately.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Generic Trunk CI runs before Envio codegen. Without .envio/types.d.ts,
      // imported entity types degrade to parser error-any and trip this rule.
      "@typescript-eslint/no-redundant-type-constituents": "off",
    },
  },
  {
    files: ["src/handlers/**/*.ts"],
    rules: {
      // Envio handler registrations require Promise-returning callbacks even
      // for synchronous entity registration bodies.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    plugins: { "unused-imports": unusedImports },
    rules: {
      "unused-imports/no-unused-imports": "error",
    },
  },
  // File-size budget — see /AGENTS.md §"File-size budget".
  {
    files: ["src/**/*.ts"],
    rules: {
      "max-lines": [
        "error",
        { max: 1000, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["test/**/*.ts", "**/*.test.ts"],
    rules: { "max-lines": "off" },
  },
  // Code-health budgets (PR 2 baseline, warn-only).
  // Default (non-handler) src/ — moderate budgets. Handlers have looser
  // budgets because Envio event-handler bodies are intentionally repetitive
  // and long (one branch per event variant + state-machine boilerplate).
  {
    files: ["src/**/*.ts"],
    plugins: { sonarjs },
    rules: {
      complexity: ["error", 15],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "max-depth": ["error", 4],
      "max-params": ["error", 4],
      "sonarjs/cognitive-complexity": ["error", 18],
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-collapsible-if": "error",
      "sonarjs/no-redundant-jump": "error",
      "sonarjs/no-small-switch": "error",
    },
  },
  {
    files: ["src/handlers/**/*.ts"],
    rules: {
      complexity: ["error", 25],
      "max-lines-per-function": [
        "error",
        { max: 150, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "max-depth": ["error", 5],
      "max-params": ["error", 6],
      "sonarjs/cognitive-complexity": ["error", 25],
      "sonarjs/no-small-switch": "off",
    },
  },
  {
    files: ["test/**/*.ts", "**/*.test.ts"],
    rules: {
      complexity: "off",
      "max-lines-per-function": "off",
      "max-depth": "off",
      "max-params": "off",
      "sonarjs/cognitive-complexity": "off",
      "sonarjs/no-identical-functions": "off",
      "sonarjs/no-collapsible-if": "off",
    },
  },
  {
    ignores: [
      "**/node_modules/**",
      "generated/**",
      ".envio/**",
      "envio-env.d.ts",
      "vitest.config.ts",
      "test/Test.ts",
      "scripts/**",
    ],
  },
);
