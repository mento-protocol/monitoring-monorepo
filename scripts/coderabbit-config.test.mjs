#!/usr/bin/env node
/**
 * Pin the disabled CodeRabbit configuration. Organization overrides can
 * supersede this file, so app removal needs separate live verification.
 * Keep exact equality to detect added settings and accidental reactivation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// CORE_SCHEMA is the YAML 1.2 core type set: no custom tags, no constructor
// resolution, so parsing the config can only ever yield plain data.
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CONFIG_PATH = path.join(REPO_ROOT, ".coderabbit.yaml");

// The canonical config. Keep this and `.coderabbit.yaml` edited together.
const EXPECTED_CONFIG = {
  chat: { auto_reply: false },
  reviews: {
    review_status: false,
    profile: "chill",
    request_changes_workflow: false,
    poem: false,
    sequence_diagrams: false,
    suggested_labels: false,
    suggested_reviewers: false,
    auto_apply_labels: false,
    collapse_walkthrough: true,
    path_instructions: [
      {
        path: "ui-dashboard/src/**/*.{ts,tsx}",
        instructions:
          "Apply the file-size policy in `ui-dashboard/AGENTS.md` and `ui-dashboard/eslint.config.mjs`.\n" +
          "Count effective lines after excluding blank lines and comments.\n" +
          "Treat 600 effective lines as the soft review threshold and 1,000 effective lines as the lint cap.\n" +
          "Do not apply these thresholds to `ui-dashboard/src/lib/__generated__/**`, `**/__tests__/**`, `**/*.test.{ts,tsx}`, or `ui-dashboard/src/lib/types.ts`.\n" +
          "Compare the effective count with the merge base. Do not request a split when the change reduces an already-over-threshold file.\n" +
          "Do not request a split only from the physical line count. Report threshold drift only when the change grows a file that remains above policy; report a separate cohesion defect independently.\n",
      },
    ],
    path_filters: [
      "!pnpm-lock.yaml",
      "!**/pnpm-lock.yaml",
      "!docs/README.md",
      "!docs/evals/documentation-navigation-baseline*.json",
      "!ui-dashboard/src/lib/__generated__/**",
      "!indexer-envio/generated/**",
      "!indexer-envio/abis/**",
      "!alerts/infra/onchain-event-handler/src/safe-abi.json",
      "!alerts/infra/onchain-event-listeners/event-hashes.json",
      "!**/eslint-baseline.json",
      "!**/__snapshots__/**",
      "!docs/evals/review-skill-runs/**",
      "!docs/evals/review-skill-truth/**",
      "!docs/evals/review-skill-finder-reports/**",
      "!docs/evals/review-skill-ledger.jsonl",
      "!docs/evals/review-skill-judge-calibration.json",
      "!.claude/skills/**",
      "!docs/metrics/**",
      "!scripts/repo-health/**",
    ],
    auto_review: {
      enabled: false,
      base_branches: [],
      drafts: false,
      auto_incremental_review: false,
      auto_pause_after_reviewed_commits: 5,
    },
  },
};

let asserted = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
    asserted += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function loadConfig() {
  return loadYaml(readFileSync(CONFIG_PATH, "utf8"), { schema: CORE_SCHEMA });
}

test("the committed .coderabbit.yaml parses as a YAML mapping", () => {
  const config = loadConfig();
  assert.equal(
    typeof config,
    "object",
    ".coderabbit.yaml must parse to an object",
  );
  assert.notEqual(config, null, ".coderabbit.yaml must not be empty");
});

test("the committed .coderabbit.yaml exactly equals the pinned config", () => {
  assert.deepEqual(loadConfig(), EXPECTED_CONFIG);
});

test("the pin rejects configuration drift and reactivation (negative control)", () => {
  // Existing profile and path settings remain pinned during retirement.
  const weakened = structuredClone(EXPECTED_CONFIG);
  weakened.reviews.path_filters.push("!scripts/**");
  assert.throws(() => assert.deepEqual(weakened, EXPECTED_CONFIG));

  const quieted = structuredClone(EXPECTED_CONFIG);
  quieted.reviews.profile = "quiet";
  assert.throws(() => assert.deepEqual(quieted, EXPECTED_CONFIG));

  const unreviewed = structuredClone(EXPECTED_CONFIG);
  unreviewed.reviews.auto_review.enabled = true;
  assert.throws(() => assert.deepEqual(unreviewed, EXPECTED_CONFIG));

  // An ADDED key must fail too — exact equality, not a spot check.
  const extended = structuredClone(EXPECTED_CONFIG);
  extended.early_access = true;
  assert.throws(() => assert.deepEqual(extended, EXPECTED_CONFIG));
});

test("pins auto-review off, incremental off, and the burst guard at five", () => {
  const { auto_review: autoReview } = EXPECTED_CONFIG.reviews;
  assert.equal(autoReview.enabled, false);
  // This verifies repository configuration, not provider runtime state.
  assert.equal(autoReview.auto_incremental_review, false);
  assert.equal(autoReview.auto_pause_after_reviewed_commits, 5);
});

process.stdout.write(`\n${asserted} passed, ${failed} failed\n`);
if (asserted === 0) {
  process.stderr.write("coderabbit-config.test.mjs asserted nothing\n");
  process.exitCode = 1;
}
if (failed > 0) process.exitCode = 1;
