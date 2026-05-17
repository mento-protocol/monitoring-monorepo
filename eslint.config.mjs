// Root-level ESLint config for repo-root build/quality scripts only.
// Per-package lint runs inside each workspace and never reaches
// `scripts/*.mjs`. Without this config a broken build script — `no-undef`,
// unused import, syntax error — could merge silently. See PR-423 codex
// finding (Keep root scripts under ESLint).
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.envio/**",
      "**/coverage/**",
      "**/.next/**",
      "**/dist/**",
      "**/.claude/worktrees/**",
      "shared-config/**",
      "ui-dashboard/**",
      "indexer-envio/**",
      "metrics-bridge/**",
    ],
  },
  {
    files: ["scripts/**/*.{mjs,cjs,js}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
