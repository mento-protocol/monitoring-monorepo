// Scoped to the two BACKLOG items: file-size cap + unused-imports.
// `tseslint.configs.recommended` would surface ~39 pre-existing nits
// (no-explicit-any, no-unused-vars, no-require-imports) that should be
// cleaned up in a separate PR before tightening this config.

import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    languageOptions: {
      parser: tseslint.parser,
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
      "test/Test.ts",
      "scripts/**",
    ],
  },
);
