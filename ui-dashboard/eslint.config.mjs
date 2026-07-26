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
import ts from "typescript";
import browserApiPolicy from "./browser-api-policy.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const symbolAwareRestrictions = browserApiPolicy.restrictions;
const TYPED_ARRAY_INTERFACE_NAMES = new Set([
  "BigInt64Array",
  "BigUint64Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
]);

function staticallyKnownPropertyName(node, computed, services, checker) {
  if (!computed && node.type === "Identifier") {
    return node.name;
  }
  if (computed && node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    computed &&
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0
  ) {
    return node.quasis[0]?.value.cooked ?? null;
  }

  if (!computed) return null;
  const propertyNode = services.esTreeNodeToTSNodeMap.get(node);
  const propertyType = checker.getTypeAtLocation(propertyNode);
  return propertyType.isStringLiteral() ? propertyType.value : null;
}

function destructuringSource(node) {
  const pattern = node.parent;
  const parent = pattern?.parent;
  if (pattern?.type !== "ObjectPattern") return null;
  if (parent?.type === "VariableDeclarator") return parent.init ?? pattern;
  if (parent?.type === "AssignmentExpression") return parent.right;
  return pattern;
}

function matchesBuiltInInterface(interfaceName, restriction) {
  if ("object" in restriction) {
    return interfaceName === `${restriction.object}Constructor`;
  }
  return restriction.receiver === "array"
    ? interfaceName === "Array" ||
        interfaceName === "ReadonlyArray" ||
        TYPED_ARRAY_INTERFACE_NAMES.has(interfaceName)
    : interfaceName === "String";
}

function hasBuiltInPropertyDeclaration(
  type,
  checker,
  program,
  restriction,
  seen = new Set(),
) {
  if (seen.has(type)) return false;
  seen.add(type);

  if (type.isUnionOrIntersection()) {
    return type.types.some((part) =>
      hasBuiltInPropertyDeclaration(part, checker, program, restriction, seen),
    );
  }

  const constraint = checker.getBaseConstraintOfType(type);
  if (
    constraint &&
    hasBuiltInPropertyDeclaration(
      constraint,
      checker,
      program,
      restriction,
      seen,
    )
  ) {
    return true;
  }

  const symbol = checker.getPropertyOfType(type, restriction.property);
  return (symbol?.getDeclarations() ?? []).some((declaration) => {
    if (!program.isSourceFileDefaultLibrary(declaration.getSourceFile())) {
      return false;
    }
    const parent = declaration.parent;
    if (!ts.isInterfaceDeclaration(parent)) return false;
    return matchesBuiltInInterface(parent.name.text, restriction);
  });
}

const symbolAwareBrowserApiRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow browser APIs only when the receiver resolves to the specified built-in instance or constructor.",
    },
    schema: [
      {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["property", "message"],
          properties: {
            receiver: { enum: ["array", "string"] },
            object: { type: "string" },
            property: { type: "string" },
            message: { type: "string" },
          },
          oneOf: [{ required: ["receiver"] }, { required: ["object"] }],
        },
      },
    ],
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
    const checker = services.program.getTypeChecker();

    return {
      MemberExpression(node) {
        const property = staticallyKnownPropertyName(
          node.property,
          node.computed,
          services,
          checker,
        );
        if (!property) return;

        const receiverNode = services.esTreeNodeToTSNodeMap.get(node.object);
        const receiverType = checker.getTypeAtLocation(receiverNode);
        const restriction = context.options[0].find(
          (candidate) =>
            candidate.property === property &&
            hasBuiltInPropertyDeclaration(
              receiverType,
              checker,
              services.program,
              candidate,
            ),
        );
        if (restriction) {
          context.report({ node: node.property, message: restriction.message });
        }
      },
      Property(node) {
        const source = destructuringSource(node);
        if (!source || node.parent.type !== "ObjectPattern") return;
        const property = staticallyKnownPropertyName(
          node.key,
          node.computed,
          services,
          checker,
        );
        if (!property) return;

        const receiverNode = services.esTreeNodeToTSNodeMap.get(source);
        const receiverType = checker.getTypeAtLocation(receiverNode);
        const restriction = context.options[0].find(
          (candidate) =>
            candidate.property === property &&
            hasBuiltInPropertyDeclaration(
              receiverType,
              checker,
              services.program,
              candidate,
            ),
        );
        if (restriction) {
          context.report({ node: node.key, message: restriction.message });
        }
      },
    };
  },
};

const browserApiPlugin = {
  rules: {
    "no-unsupported-receiver-property": symbolAwareBrowserApiRule,
  },
};

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
  // Type-aware async-safety + exhaustiveness rules. `projectService: true`
  // pulls TS type info. Scoped to `src/**/*.{ts,tsx}` minus tests + `.d.ts`
  // ambient declarations: the project service doesn't pick those up (they
  // aren't reachable from the entry points it loads), and the rules add
  // little signal there — test mocks naturally use async callbacks, and
  // `.d.ts` files are type-only. Tests don't have runtime async surfaces
  // worth gating.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.d.ts", "src/**/__tests__/**", "src/**/*.test.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // `checksVoidReturn.attributes: false` is the standard React config:
      // React's synthetic event system handles async event-handler attributes
      // (`<button onClick={async () => ...}>`) correctly — rejected promises
      // are swallowed without becoming unhandled rejections. Other void-return
      // contexts (setTimeout callbacks, function arguments, etc.) still fire
      // and catch genuine bugs like the `poller.ts` floating-loop fixed in
      // this PR.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
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
  // File-size budget — see docs/pr-checklists/recurring-review-patterns.md.
  // Hard cap blocks merge; the 600-line soft cap is advisory in that checklist.
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
  // violations are captured in `eslint-baseline.json` and gated by
  // `scripts/eslint-baseline-diff.mjs`. New violations not absorbed by
  // line-proximity matching against the baseline fail the gate. See
  // `docs/pr-checklists/code-health.md` for the full cleanup workflow
  // and a record of the prior mechanisms (max-warnings, bulk
  // suppressions, line-only keys, content-fingerprint keys) and why
  // they were rejected. React components exempt from max-depth (JSX
  // nesting isn't counted) and max-lines-per-function (component
  // bodies legitimately long when they assemble many sub-elements).
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
  // Backstop for the package.json runtime floor (Chrome/Edge/Firefox 111+,
  // Safari 16.4+). These APIs compile because the TS `lib` includes `esnext`,
  // but are unavailable in part of that browser range. `toSorted` callers use
  // `sortedCopy` from `@/lib/immutable-sort`; the other messages name the
  // compatible form. Excludes paths that run on Node >=20 and never ship to
  // the browser, plus tests. Deliberately narrower than the broader
  // server-only surface in "Server vs client module boundaries" (e.g.
  // `bridge-flows-og.ts`, `opengraph-image.tsx`) — widen the ignore list if a
  // future PR needs ES2023+ there instead of hand-rolling the ES2017 form.
  {
    files: browserApiPolicy.clientFiles,
    ignores: browserApiPolicy.serverAndTestIgnores,
    plugins: { "browser-api-policy": browserApiPlugin },
    rules: {
      "browser-api-policy/no-unsupported-receiver-property": [
        "error",
        symbolAwareRestrictions,
      ],
    },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.next-fixture/**",
      "coverage/**",
      "**/.trunk/**",
      "**/*.mjs",
    ],
  },
);
