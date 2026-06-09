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
      // Generic Trunk CI runs before Envio codegen. Without .envio/types.d.ts,
      // imported entity types degrade to parser error-any and trip this rule.
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // Not in `recommendedTypeChecked` but a high-value forward-compat
      // guard: forces every `switch` on a discriminated union / enum to
      // handle each variant. Catches the "new event variant added, old
      // switch silently falls through" class of bug.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    // `src/performance.ts` is deliberately reflection-heavy: it Proxy-wraps
    // Envio's entity/effect/context operations to record per-handler stats.
    // `Reflect.get` returns `any` by design, and the wrapped function values
    // can't be typed without losing the dynamic Proxy semantics. The unsafe-*
    // disables stay scoped to this single file rather than the whole src/
    // tree, so new code is fully covered by `recommendedTypeChecked`.
    files: ["src/performance.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
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
  // Code-health budgets. Rules ship at `error` severity; pre-existing
  // violations live in `eslint-baseline.json` and are gated by
  // `scripts/eslint-baseline-diff.mjs` (see docs/pr-checklists/code-health.md).
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
      "coverage/**",
      "generated/**",
      ".envio/**",
      "envio-env.d.ts",
      "vitest.config.ts",
      "test/Test.ts",
      "scripts/**",
    ],
  },
);
