// Root-level ESLint config for repo-root build/quality scripts and
// config files. Per-package lint runs inside each workspace and never
// reaches `scripts/*.mjs` or root-level `.cjs` config files like
// `.dependency-cruiser.cjs`. Without this config a broken build script
// or architecture rule — `no-undef`, unused import, syntax error —
// could merge silently. See PR-423 codex findings:
//   - Keep root scripts under ESLint (round 3)
//   - Keep the dep-cruiser config under ESLint (round 5)
import js from "@eslint/js";
import globals from "globals";

const recommendedRules = {
  ...js.configs.recommended.rules,
  "no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
};

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
      "aegis/**",
      "alerts/**",
    ],
  },
  {
    // ESM scripts and root .mjs config files.
    files: ["scripts/**/*.{mjs,js}", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: recommendedRules,
  },
  {
    // CommonJS scripts and root .cjs config files (e.g.
    // .dependency-cruiser.cjs).
    files: ["scripts/**/*.cjs", "*.cjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: recommendedRules,
  },
];
