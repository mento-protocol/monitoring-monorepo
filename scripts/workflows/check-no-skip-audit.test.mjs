#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditAggregateViolations,
  noSkipAuditViolations,
} from "./check-no-skip-audit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = [
  ".github/workflows/no-skip-audit.yml",
  ".github/workflows/ci.yml",
  ".github/actions/pnpm-install/action.yml",
  ".github/actions/resolve-eslint-baseline/action.yml",
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "no-skip-audit-"));
  for (const path of FILES)
    cpSync(join(ROOT, path), join(root, path), { recursive: true });
  return root;
}

function mutateOnce(path, before, after, expected) {
  const root = fixture();
  try {
    const absolute = join(root, path);
    const original = readFileSync(absolute, "utf8");
    assert(original.includes(before), `${path} mutation anchor exists`);
    writeFileSync(absolute, original.replace(before, after));
    assert.match(noSkipAuditViolations(root).join("\n"), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const DISPATCH = ".github/workflows/no-skip-audit.yml";
const CI = ".github/workflows/ci.yml";
const PNPM = ".github/actions/pnpm-install/action.yml";
const BASELINE = ".github/actions/resolve-eslint-baseline/action.yml";

// Each mutation removes one admission, trust, normalization, or cold-run fact.
// prettier-ignore
const MUTATIONS = [
  ["scheduled trigger", DISPATCH, "on:\n  workflow_dispatch:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:", /only the three manual immutable inputs/u],
  ["run identity", DISPATCH, "run-name: \"No-skip audit PR #", "run-name: \"Audit PR #", /identity changed/u],
  ["dispatcher concurrency", DISPATCH, "permissions: read-all", "permissions: read-all\n\nconcurrency: no-skip-audit", /omit redundant concurrency/u],
  ["workflow write authority", DISPATCH, "permissions: read-all", "permissions: write-all", /workflow must remain read-only/u],
  ["dispatch event admission", DISPATCH, 'context.eventName !== "workflow_dispatch"', 'context.eventName !== "push"', /admission script changed/u],
  ["full source SHA", DISPATCH, "const shaPattern = /^[0-9a-f]{40}$/;", "const shaPattern = /^[0-9a-f]{7,40}$/;", /admission script changed/u],
  ["protected dispatch ref", DISPATCH, 'context.ref !== "refs/heads/main"', 'context.ref !== "refs/heads/dev"', /admission script changed/u],
  ["dispatch revision binding", DISPATCH, "context.sha !== baseSha", "context.sha === baseSha", /admission script changed/u],
  ["open PR admission", DISPATCH, 'pull.state !== "open"', 'pull.state === "open"', /admission script changed/u],
  ["same head repository", DISPATCH, "pull.head.repo?.full_name !== context.repo.owner", "pull.head.repo?.full_name === context.repo.owner", /admission script changed/u],
  ["same base repository", DISPATCH, "pull.base.repo?.full_name !== context.repo.owner", "pull.base.repo?.full_name === context.repo.owner", /admission script changed/u],
  ["main base branch", DISPATCH, 'pull.base.ref !== "main"', 'pull.base.ref !== "develop"', /admission script changed/u],
  ["PR head binding", DISPATCH, "pull.head.sha !== sourceSha", "pull.head.sha === sourceSha", /admission script changed/u],
  ["PR base binding", DISPATCH, "pull.base.sha !== baseSha", "pull.base.sha === baseSha", /admission script changed/u],
  ["live main binding", DISPATCH, "main.object.sha !== baseSha", "main.object.sha === baseSha", /admission script changed/u],
  ["candidate checkout ref", DISPATCH, "          ref: ${{ inputs.source_sha }}", "          ref: ${{ inputs.base_sha }}", /exact source/u],
  ["candidate checkout depth", DISPATCH, "          fetch-depth: 0", "          fetch-depth: 1", /full history/u],
  ["candidate checkout credentials", DISPATCH, "          persist-credentials: false", "          persist-credentials: true", /no credentials/u],
  ["admission dependency", DISPATCH, "    needs: admit", "    needs: changes", /depend on admission/u],
  ["protected workflow reference", DISPATCH, "    uses: $/.github/workflows/ci.yml", "    uses: ./.github/workflows/ci.yml", /call protected CI/u],
  ["workflow-call lint scope", DISPATCH, "# trunk-ignore(actionlint/workflow-call)", "# trunk-ignore(actionlint/syntax-check)", /line-scoped actionlint/u],
  ["dispatch input lint scope", DISPATCH, "# checkov:skip=CKV_GHA_7:", "# checkov:skip=CKV_GHA_1:", /Checkov exception/u],
  ["secret inheritance", DISPATCH, "    uses: $/.github/workflows/ci.yml\n    with:", "    uses: $/.github/workflows/ci.yml\n    secrets: inherit\n    with:", /call protected CI|not receive secrets/u],
  ["exact source forwarding", DISPATCH, "      audit_source_sha: ${{ inputs.source_sha }}", "      audit_source_sha: ${{ inputs.base_sha }}", /exact inputs/u],
  ["unused PR forwarding", DISPATCH, "      no_skip_audit: true", "      no_skip_audit: true\n      audit_pr_number: ${{ inputs.pr_number }}", /exact inputs/u],
  ["optional Codecov secret", CI, "        required: false\n\n# Concurrency", "        required: true\n\n# Concurrency", /optional Codecov secret/u],
  ["independent called concurrency", CI, "format('ci-no-skip-{0}', github.run_id)", "format('ci-no-skip-{0}', inputs.audit_source_sha)", /keep audit runs independent/u],
  ["force-all audit", CI, "${{ inputs.no_skip_audit || steps.filter.outputs.controlPlane", "${{ steps.filter.outputs.controlPlane", /force every routed job/u],
  ["audit changes checkout", CI, "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        if: ${{ !inputs.no_skip_audit }}\n        with:\n          persist-credentials: false", "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false", /bypass mutable change selection/u],
  ["audit paths filter", CI, "      - id: filter\n        if: ${{ !inputs.no_skip_audit }}", "      - id: filter", /bypass mutable change selection/u],
  ["candidate job checkout", CI, "          ref: ${{ inputs.no_skip_audit && inputs.audit_source_sha || github.sha }}", "          ref: ${{ github.sha }}", /exact candidate/u],
  ["candidate audit depth", CI, "          fetch-depth: ${{ inputs.no_skip_audit && '0' || '1' }}", "          fetch-depth: 1", /full audit history/u],
  ["candidate job force-all", CI, "    if: needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.shared == 'true'", "    if: needs.changes.outputs.shared == 'true'", /can skip during/u],
  ["protected self action", CI, "      - uses: $/.github/actions/pnpm-install", "      - uses: ./.github/actions/pnpm-install", /protected running commit/u],
  ["self-action lint scope", CI, "# trunk-ignore(actionlint/action)", "# trunk-ignore(actionlint/syntax-check)", /line-scoped actionlint/u],
  ["pnpm cache restore", CI, "          restore-cache: ${{ !inputs.no_skip_audit }}", "          restore-cache: true", /disable persistent cache/u],
  ["pnpm cache writer", CI, "          write-cache: ${{ !inputs.no_skip_audit && github.event_name", "          write-cache: ${{ github.event_name", /disable persistent cache/u],
  ["ESLint admitted baseline", CI, "          baseline-ref: ${{ inputs.no_skip_audit && inputs.audit_base_sha || 'origin/main' }}", "          baseline-ref: origin/main", /ESLint baselines/u],
  ["baseline action input", BASELINE, "        BASELINE_REF: ${{ inputs.baseline-ref }}", "        BASELINE_REF: origin/main", /caller-owned base/u],
  ["React Doctor admitted baseline", CI, "          BASELINE_REF: ${{ inputs.no_skip_audit && inputs.audit_base_sha", "          BASELINE_REF: origin/main # ${{ inputs.no_skip_audit && inputs.audit_base_sha", /React Doctor/u],
  ["React Doctor quoted env", CI, 'react-doctor --diff "$BASELINE_REF"', "react-doctor --diff ${{ inputs.audit_base_sha }}", /shell steps through quoted environment|React Doctor/u],
  ["Peg admitted baseline", CI, "          PEG_POLICY_BASE_REF: ${{ inputs.no_skip_audit && inputs.audit_base_sha", "          PEG_POLICY_BASE_REF: origin/main # ${{ inputs.no_skip_audit && inputs.audit_base_sha", /Peg policy lineage/u],
  ["Terraform admitted baseline", CI, "          AUDIT_BASE_SHA: ${{ inputs.audit_base_sha }}", "          AUDIT_BASE_SHA: ${{ github.sha }}", /Terraform selection/u],
  ["ADR admitted baseline", CI, "          AGENT_QUALITY_BASE: ${{ inputs.no_skip_audit && inputs.audit_base_sha || 'origin/main' }}", "          AGENT_QUALITY_BASE: origin/main", /ADR reminder/u],
  ["Playwright cache restore", CI, "      - name: Restore Playwright Chromium\n        id: playwright-cache\n        if: ${{ !inputs.no_skip_audit }}", "      - name: Restore Playwright Chromium\n        id: playwright-cache", /Playwright cache/u],
  ["Playwright cache save", CI, "if: ${{ !inputs.no_skip_audit && github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.playwright-cache", "if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.playwright-cache", /Playwright cache/u],
  ["Foundry cache", CI, "          cache: ${{ !inputs.no_skip_audit && github.event_name", "          cache: ${{ github.event_name", /Foundry cache/u],
  ["Turbo cold policy", CI, "TURBO_CACHE_POLICY: ${{ inputs.no_skip_audit && 'local:,remote:' || 'local:rw' }}", "TURBO_CACHE_POLICY: local:rw", /Turbo cache/u],
  ["Codecov audit skip", CI, "if: ${{ !inputs.no_skip_audit && !startsWith(github.event.pull_request.head.ref", "if: ${{ !startsWith(github.event.pull_request.head.ref", /Codecov/u],
  ["UI artifact audit skip", CI, "        if: failure() && !inputs.no_skip_audit", "        if: failure()", /UI failure artifacts/u],
  ["timeline audit skip", CI, "        if: always() && !inputs.no_skip_audit", "        if: always()", /timeline actions/u],
  ["audit allowed skip", CI, "        with:\n          jobs: ${{ toJSON(needs) }}\n      - uses: Kesin11/actions-timeline", "        with:\n          jobs: ${{ toJSON(needs) }}\n          allowed-skips: ui\n      - uses: Kesin11/actions-timeline", /reject every skipped/u],
  ["audit gate condition", CI, "        if: ${{ inputs.no_skip_audit }}\n        uses: re-actors/alls-green", "        if: ${{ !inputs.no_skip_audit }}\n        uses: re-actors/alls-green", /reject every skipped/u],
  ["protected pnpm restore guard", PNPM, "      if: inputs.restore-cache == 'true'", "      if: 'true'", /pnpm action/u],
  ["protected pnpm save guard", PNPM, "      if: inputs.restore-cache == 'true' && inputs.write-cache", "      if: inputs.write-cache", /pnpm action/u],
];

test("the live no-skip audit satisfies its closed contract", () => {
  assert.deepEqual(noSkipAuditViolations(ROOT), []);
});

for (const [label, path, before, after, expected] of MUTATIONS) {
  test(`rejects ${label}`, () => mutateOnce(path, before, after, expected));
}

test("audit result semantics reject skips, misses, failures, and extras", () => {
  const expected = ["changes", "ui"];
  assert.deepEqual(
    auditAggregateViolations(
      { changes: "success", ui: { result: "success" } },
      expected,
    ),
    [],
  );
  assert.match(
    auditAggregateViolations(
      { changes: "success", ui: "skipped" },
      expected,
    ).join("\n"),
    /ui=skipped/u,
  );
  assert.match(
    auditAggregateViolations({ changes: "success" }, expected).join("\n"),
    /missing job: ui/u,
  );
  assert.match(
    auditAggregateViolations(
      { changes: "failure", ui: "success" },
      expected,
    ).join("\n"),
    /changes=failure/u,
  );
  assert.match(
    auditAggregateViolations(
      { changes: "success", ui: "success", rogue: "success" },
      expected,
    ).join("\n"),
    /unexpected job: rogue/u,
  );
});

test("the M4 checker and mutation suite stay within phase budgets", () => {
  const implementationLines =
    readFileSync(
      join(ROOT, "scripts/workflows/check-no-skip-audit.mjs"),
      "utf8",
    ).split("\n").length - 1;
  const testLines =
    readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").length - 1;
  assert(
    implementationLines <= 300,
    `${implementationLines} implementation lines`,
  );
  assert(testLines <= 500, `${testLines} test lines`);
  assert(MUTATIONS.length >= 20, `${MUTATIONS.length} focused mutations`);
});
