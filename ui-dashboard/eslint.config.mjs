import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "@eslint-react/eslint-plugin";
import reactDoctor from "react-doctor/eslint-plugin";
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactNoUnneededEffect from "eslint-plugin-react-you-might-not-need-an-effect";
import unusedImports from "eslint-plugin-unused-imports";
import sonarjs from "eslint-plugin-sonarjs";
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
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-doctor": reactDoctor },
    rules: {
      ...reactDoctor.configs.recommended.rules,
      ...reactDoctor.configs.next.rules,
      "react-doctor/design-no-default-tailwind-palette": "off",
      "react-doctor/design-no-em-dash-in-jsx-text": "off",
      "react-doctor/design-no-redundant-size-axes": "off",
      "react-doctor/design-no-bold-heading": "off",
      "react-doctor/js-tosorted-immutable": "off",
      // react-doctor 0.1.x can apply this rule to non-component helpers.
      // The standalone CLI remains the authoritative full scan.
      "react-doctor/prefer-useReducer": "off",
      // Existing actionable/noisy debt stays owned by the standalone
      // react-doctor CLI and BACKLOG.md. Keep the ESLint plugin useful for
      // IDE-time coverage without duplicating the CLI's suppression syntax.
      "react-doctor/async-await-in-loop": "off",
      "react-doctor/async-defer-await": "off",
      "react-doctor/async-parallel": "off",
      "react-doctor/js-combine-iterations": "off",
      "react-doctor/nextjs-no-use-search-params-without-suspense": "off",
      "react-doctor/no-array-index-as-key": "off",
      "react-doctor/no-cascading-set-state": "off",
      "react-doctor/no-derived-useState": "off",
      "react-doctor/no-giant-component": "off",
      "react-doctor/no-inline-exhaustive-style": "off",
      "react-doctor/no-many-boolean-props": "off",
      "react-doctor/react-compiler-destructure-method": "off",
      "react-doctor/rerender-state-only-in-handlers": "off",
    },
  },
  {
    ...reactNoUnneededEffect.configs.recommended,
    files: ["**/*.{ts,tsx}"],
    rules: {
      ...reactNoUnneededEffect.configs.recommended.rules,
      // This rule currently false-positives on debounced input and URL-state
      // synchronization hooks. Keep the companion plugin installed while the
      // remaining rules provide IDE-time coverage.
      "react-you-might-not-need-an-effect/no-event-handler": "off",
    },
  },
  {
    plugins: { "unused-imports": unusedImports },
    rules: {
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, React: "readonly" },
    },
  },
  // File-size budget — see AGENTS.md §"File-size budget" for rationale.
  // Hard cap blocks merge; the 600-line soft cap is advisory in AGENTS.md.
  // Per-file escape: `// eslint-disable-next-line max-lines` with a comment
  // explaining why the file genuinely needs to stay big.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "max-lines": [
        "error",
        { max: 1000, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}", "src/lib/types.ts"],
    rules: { "max-lines": "off" },
  },
  {
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}", "scripts/**"],
    rules: {
      "react-doctor/no-secrets-in-client-code": "off",
    },
  },
  // Code-health budgets. Rules ship at `error` severity; pre-existing
  // violations are captured in `eslint-suppressions.json` (ESLint bulk
  // suppressions, 9.24+). New violations not in that file fail the gate
  // — the `--max-warnings` cap was insufficient (codex P2 #3253043406):
  // a PR could delete one warning and add a different one and stay under
  // the cap. Cleanup PRs fix a violation and run `eslint --prune-suppressions`
  // to drop the entry. React components exempt from max-depth (JSX nesting
  // isn't counted) and max-lines-per-function (component bodies legitimately
  // long when they assemble many sub-elements).
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { sonarjs },
    rules: {
      complexity: ["error", 15],
      "max-lines-per-function": [
        "error",
        { max: 100, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "max-depth": ["error", 4],
      "max-params": ["error", 5],
      "sonarjs/cognitive-complexity": ["error", 18],
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-collapsible-if": "error",
      "sonarjs/no-redundant-jump": "error",
      "sonarjs/no-small-switch": "error",
    },
  },
  {
    files: [
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      "src/lib/types.ts",
      "scripts/**",
    ],
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
      "**/.next/**",
      "coverage/**",
      "**/.trunk/**",
      "**/*.mjs",
    ],
  },
);
