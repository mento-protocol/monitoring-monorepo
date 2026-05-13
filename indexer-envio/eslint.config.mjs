import js from "@eslint/js";
import unusedImports from "eslint-plugin-unused-imports";
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
