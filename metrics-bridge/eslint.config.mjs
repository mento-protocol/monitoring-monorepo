import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
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
  { ignores: ["**/node_modules/**", "dist/**"] },
);
