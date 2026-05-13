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
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { tsconfigRootDir: __dirname },
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
