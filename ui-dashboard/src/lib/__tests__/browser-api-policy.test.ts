import { ESLint } from "eslint";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import browserApiPolicy from "../../../browser-api-policy.json";

const DASHBOARD_ROOT_URL = new URL("../../../", import.meta.url);
const CLIENT_FIXTURE_PATH = "src/lib/immutable-sort.ts";
const ROOT_CLIENT_FIXTURE_PATH = "sentry.shared.ts";
const ROOT_SERVER_FIXTURE_PATH = "sentry.server.config.ts";
const SERVER_FIXTURE_PATH = "src/app/api/address-labels/route.ts";
const OG_FIXTURE_PATH = "src/lib/homepage-og.ts";
const TEST_FIXTURE_PATH = "src/lib/__tests__/browser-api-policy.test.ts";
const SYMBOL_AWARE_RULE_ID =
  "browser-api-policy/no-unsupported-receiver-property";
// One ESLint program load lints every fixture below, in a subprocess shared by
// the whole file. Its cost is CPU-bound and near-constant (~17s of user time on
// a 12-core mac); what varies is how much of a core it gets. Measured while the
// machine carried a load average around 30 — the normal state of a host several
// agents share — the same subprocess took 29-38s of wall clock, so the old
// per-test 30s budget failed for reasons that had nothing to do with the
// policy under test (GitHub issue #1802). The gate now runs this suite in its
// own exclusive phase; this budget covers the machine ALSO being busy with work
// the gate does not schedule, while still failing a runner that hangs.
const LINT_RUNNER_TIMEOUT_MS = 120_000;
// In-process `calculateConfigForFile` on a cold ESLint cache: measured ~3.8s
// under the same load, milliseconds once warm.
const CONFIG_LOOKUP_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);
const eslint = new ESLint({
  cwd: fileURLToPath(DASHBOARD_ROOT_URL),
  overrideConfigFile: fileURLToPath(
    new URL("eslint.config.mjs", DASHBOARD_ROOT_URL),
  ),
});
type LintCase =
  | "blocked"
  | "typedArrayBlocked"
  | "destructuredBlocked"
  | "computedBlocked"
  | "staticBlocked"
  | "staticAllowed"
  | "computedAllowed"
  | "allowed"
  | "api"
  | "og"
  | "test"
  | "rootServer";
type BrowserApiMessage = { ruleId: string; message: string };
const lintResultsPromise = execFileAsync(
  process.execPath,
  [
    fileURLToPath(
      new URL(
        "../../../scripts/browser-api-policy-lint-runner.mjs",
        import.meta.url,
      ),
    ),
  ],
  {
    cwd: fileURLToPath(DASHBOARD_ROOT_URL),
    encoding: "utf8",
    env: { ...process.env, NODE_V8_COVERAGE: undefined },
    maxBuffer: 1024 * 1024,
  },
).then(
  ({ stdout }) => JSON.parse(stdout) as Record<LintCase, BrowserApiMessage[]>,
);

async function browserApiRules(filePath: string) {
  const config = await eslint.calculateConfigForFile(
    fileURLToPath(new URL(filePath, DASHBOARD_ROOT_URL)),
  );
  return {
    property: config?.rules?.["no-restricted-properties"],
    symbolAware: config?.rules?.[SYMBOL_AWARE_RULE_ID],
  };
}

let lintResults: Record<LintCase, BrowserApiMessage[]>;

async function browserApiMessages(lintCase: LintCase) {
  return lintResults[lintCase];
}

describe("browser runtime API policy", () => {
  // The lint runner is a fixture, not one test's work. Awaiting it inside
  // whichever test happened to reach it first charged that test's timeout for a
  // subprocess shared by six of them, and reported a starved machine as a
  // policy assertion failure. Waiting here names the real thing that was slow.
  beforeAll(async () => {
    lintResults = await lintResultsPromise;
  }, LINT_RUNNER_TIMEOUT_MS);

  it("pins the Next.js 16 browser floor", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("package.json", DASHBOARD_ROOT_URL), "utf8"),
    ) as { browserslist?: string[] };

    expect(packageJson.browserslist).toEqual(browserApiPolicy.browsers);
  });

  it("uses the exact blocked sets in the effective client config", async () => {
    const rules = await browserApiRules(CLIENT_FIXTURE_PATH);
    expect(rules.property).toBeUndefined();
    expect(rules.symbolAware).toEqual([2, browserApiPolicy.restrictions]);
  });

  it("does not configure a generic property ban", async () => {
    const rules = await browserApiRules(CLIENT_FIXTURE_PATH);
    expect(rules.property).toBeUndefined();
  });

  it("reports every blocked API with its intended rule and message", async () => {
    const messages = await browserApiMessages("blocked");

    expect(messages).toHaveLength(browserApiPolicy.restrictions.length);
    for (const restriction of browserApiPolicy.restrictions) {
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: SYMBOL_AWARE_RULE_ID,
            message: expect.stringContaining(restriction.message),
          }),
        ]),
      );
    }
  });

  it(
    "applies the policy to browser dependencies at the package root",
    async () => {
      const rules = await browserApiRules(ROOT_CLIENT_FIXTURE_PATH);

      expect(rules.symbolAware).toEqual([2, browserApiPolicy.restrictions]);
    },
    CONFIG_LOOKUP_TIMEOUT_MS,
  );

  it("reports unsupported change-by-copy methods on typed arrays", async () => {
    const messages = await browserApiMessages("typedArrayBlocked");
    const properties = new Set(["toSorted", "toReversed", "with"]);
    const restrictions = browserApiPolicy.restrictions.filter(
      (restriction) =>
        "receiver" in restriction && properties.has(restriction.property),
    );

    expect(messages).toHaveLength(restrictions.length);
    for (const restriction of restrictions) {
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: SYMBOL_AWARE_RULE_ID,
            message: expect.stringContaining(restriction.message),
          }),
        ]),
      );
    }
  });

  it("reports blocked methods extracted through destructuring", async () => {
    const messages = await browserApiMessages("destructuredBlocked");
    const properties = new Set(["toSorted", "toReversed", "isWellFormed"]);
    const restrictions = browserApiPolicy.restrictions.filter(
      (restriction) =>
        "receiver" in restriction && properties.has(restriction.property),
    );

    expect(messages).toHaveLength(restrictions.length);
    for (const restriction of restrictions) {
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: SYMBOL_AWARE_RULE_ID,
            message: expect.stringContaining(restriction.message),
          }),
        ]),
      );
    }
  });

  it("reports blocked APIs through statically known computed keys", async () => {
    const messages = await browserApiMessages("computedBlocked");
    const exercisedProperties = new Set([
      "toSorted",
      "toReversed",
      "toSpliced",
      "groupBy",
      "toWellFormed",
    ]);

    expect(messages).toHaveLength(7);
    for (const restriction of browserApiPolicy.restrictions) {
      if (!exercisedProperties.has(restriction.property)) continue;
      expect(
        messages.filter((message) => message.message === restriction.message),
      ).toHaveLength(restriction.property === "toSorted" ? 2 : 1);
    }
  });

  it("reports static built-ins through direct, aliased, qualified, and destructured access", async () => {
    const messages = await browserApiMessages("staticBlocked");
    const restrictions = browserApiPolicy.restrictions.filter(
      (restriction) => "object" in restriction,
    );

    expect(messages).toHaveLength(restrictions.length * 4);
    for (const restriction of restrictions) {
      expect(
        messages.filter((message) => message.message === restriction.message),
      ).toHaveLength(4);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: SYMBOL_AWARE_RULE_ID }),
        ]),
      );
    }
  });

  it("allows shadowed and custom static groupBy methods", async () => {
    const messages = await browserApiMessages("staticAllowed");

    expect(messages).toEqual([]);
  });

  it("allows computed keys on shadowed and custom receivers", async () => {
    const messages = await browserApiMessages("computedAllowed");

    expect(messages).toEqual([]);
  });

  it("allows floor-compatible APIs and arbitrary same-name methods", async () => {
    const messages = await browserApiMessages("allowed");

    expect(messages).toEqual([]);
  });

  it.each([
    ["an explicit server-only route", SERVER_FIXTURE_PATH, "api"],
    ["an explicit OG helper", OG_FIXTURE_PATH, "og"],
    ["a test", TEST_FIXTURE_PATH, "test"],
    ["a root server config", ROOT_SERVER_FIXTURE_PATH, "rootServer"],
  ] as const)(
    "allows the blocked APIs in %s",
    async (_surface, filePath, lintCase) => {
      const [rules, messages] = await Promise.all([
        browserApiRules(filePath),
        browserApiMessages(lintCase),
      ]);

      expect(rules.property).toBeUndefined();
      expect(rules.symbolAware).toBeUndefined();
      expect(messages).toEqual([]);
    },
  );
});
