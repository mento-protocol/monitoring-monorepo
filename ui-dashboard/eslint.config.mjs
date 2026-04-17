import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "@eslint-react/eslint-plugin";
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ...reactPlugin.configs["recommended-typescript"],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ...reactPlugin.configs["recommended-typescript"].languageOptions,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { tsconfigRootDir: __dirname },
    },
  },
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    plugins: { "jsx-a11y": jsxA11y },
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, React: "readonly" },
    },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "coverage/**",
      "**/.trunk/**",
    ],
  },
);
