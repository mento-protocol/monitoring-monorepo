#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

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

const DISPATCH = ".github/workflows/no-skip-audit.yml",
  CI = ".github/workflows/ci.yml";
const PNPM = ".github/actions/pnpm-install/action.yml";
const BASELINE = ".github/actions/resolve-eslint-baseline/action.yml";

// Each mutation removes one admission, trust, normalization, or cold-run fact.
// prettier-ignore
const MUTATIONS = [
  ["scheduled trigger", DISPATCH, "on:\n  workflow_dispatch:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:", /only the three manual immutable inputs/u],
  ["run identity", DISPATCH, "run-name: \"No-skip audit PR #", "run-name: \"Audit PR #", /identity changed/u],
  ["dispatcher concurrency", DISPATCH, "permissions: read-all", "permissions: read-all\n\nconcurrency: no-skip-audit", /omit redundant concurrency/u],
  ["workflow write authority", DISPATCH, "permissions: read-all", "permissions: write-all", /workflow must remain read-only/u],
  ["dispatcher shell startup environment", DISPATCH, "permissions: read-all", "permissions: read-all\nenv:\n  BASH_ENV: scripts/agent-quality-gate.test.sh", /dispatcher runtime keys/u],
  ["dispatcher run defaults", DISPATCH, "permissions: read-all", "permissions: read-all\ndefaults:\n  run:\n    shell: bash scripts/agent-quality-gate.test.sh {0}", /dispatcher runtime keys/u],
  ["dispatch event admission", DISPATCH, 'context.eventName !== "workflow_dispatch"', 'context.eventName !== "push"', /admission script changed/u],
  ["skipped admission validation", DISPATCH, "      - name: Validate protected-main dispatch inputs\n        uses:", "      - name: Validate protected-main dispatch inputs\n        if: false\n        uses:", /admission script changed/u],
  ["nonblocking admission checkout", DISPATCH, "      - name: Check out immutable candidate\n        uses:", "      - name: Check out immutable candidate\n        continue-on-error: true\n        uses:", /candidate checkout step changed/u],
  ["skipped admission summary", DISPATCH, "      - name: Verify exact source and base objects\n        env:", "      - name: Verify exact source and base objects\n        if: false\n        env:", /operational summary changed/u],
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
  ["candidate checkout ref", DISPATCH, "          ref: ${{ inputs.source_sha }}", "          ref: ${{ inputs.base_sha }}", /candidate checkout step changed/u],
  ["candidate checkout depth", DISPATCH, "          fetch-depth: 0", "          fetch-depth: 1", /candidate checkout step changed/u],
  ["candidate checkout credentials", DISPATCH, "          persist-credentials: false", "          persist-credentials: true", /candidate checkout step changed/u],
  ["candidate protected drift condition", DISPATCH, "      - name: Reject candidate execution or evidence-instrument drift\n        env:", "      - name: Reject candidate execution or evidence-instrument drift\n        if: ${{ !cancelled() }}\n        env:", /candidate-execution or evidence-instrument drift check/u],
  ["candidate protected drift path set", DISPATCH, '            ":(glob)**/package.json"', '            ":(glob)**/other.json"', /candidate-execution or evidence-instrument drift check/u],
  ["admission dependency", DISPATCH, "    needs: admit", "    needs: changes", /depend on admission/u],
  ["protected workflow reference", DISPATCH, "    uses: $/.github/workflows/ci.yml", "    uses: ./.github/workflows/ci.yml", /call protected CI/u],
  ["workflow-call lint scope", DISPATCH, "# trunk-ignore(actionlint/workflow-call)", "# trunk-ignore(actionlint/syntax-check)", /line-scoped actionlint/u],
  ["dispatch input lint scope", DISPATCH, "# checkov:skip=CKV_GHA_7:", "# checkov:skip=CKV_GHA_1:", /Checkov exception/u],
  ["secret inheritance", DISPATCH, "    uses: $/.github/workflows/ci.yml\n    with:", "    uses: $/.github/workflows/ci.yml\n    secrets: inherit\n    with:", /call protected CI|not receive secrets/u],
  ["exact source forwarding", DISPATCH, "      audit_source_sha: ${{ inputs.source_sha }}", "      audit_source_sha: ${{ inputs.base_sha }}", /exact inputs/u],
  ["unused PR forwarding", DISPATCH, "      no_skip_audit: true", "      no_skip_audit: true\n      audit_pr_number: ${{ inputs.pr_number }}", /exact inputs/u],
  ["optional Codecov secret", CI, "        required: false\n\n# Concurrency", "        required: true\n\n# Concurrency", /optional Codecov secret/u],
  ["reusable permission ceiling regression", CI, "permissions:\n  actions: read\n  contents: read\n  pull-requests: read\n\njobs:", "permissions: read-all\n\njobs:", /permission ceilings must match exact read-only scopes/u],
  ["reusable workflow write authority", CI, "permissions:\n  actions: read\n  contents: read\n  pull-requests: read\n\njobs:", "permissions:\n  actions: read\n  contents: write\n  pull-requests: read\n\njobs:", /permission ceilings must match exact read-only scopes/u],
  ["inherited job permission ceiling", CI, "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      contents: read\n      actions: read", "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10", /every reusable CI job must keep explicit narrow read-only permissions/u],
  ["independent called concurrency", CI, "format('ci-no-skip-{0}', github.run_id)", "format('ci-no-skip-{0}', inputs.audit_source_sha)", /keep audit runs independent/u],
  ["force-all audit", CI, "${{ inputs.no_skip_audit || steps.filter.outputs.controlPlane", "${{ steps.filter.outputs.controlPlane", /force every routed job/u],
  ["retained audit input description", CI, "description: Run every retained deterministic job", "description: Run every deterministic job", /reusable CI audit inputs/u],
  ["legacy indexer router in audit", CI, "      - name: Legacy indexer routing parity suite\n        # This remaining suite checks only the legacy local gate's table and\n        # checklist router. The no-skip audit measures retained commands.\n        if: ${{ !inputs.no_skip_audit }}", "      - name: Legacy indexer routing parity suite\n        # This remaining suite checks only the legacy local gate's table and\n        # checklist router. The no-skip audit measures retained commands.", /exclude the exact legacy local-gate step inventory/u],
  ["legacy Bash gate in audit", CI, "      - name: Agent quality-gate routing regression suite\n        # Keep the mandatory legacy gate safe during the shadow period. The\n        # no-skip audit measures only commands retained after gate retirement.\n        if: ${{ !inputs.no_skip_audit }}", "      - name: Agent quality-gate routing regression suite\n        # Keep the mandatory legacy gate safe during the shadow period. The\n        # no-skip audit measures only commands retained after gate retirement.", /exclude the exact legacy local-gate step inventory/u],
  ["legacy routing table in audit", CI, "        # It is not part of the retained no-skip target command set.\n        if: ${{ !inputs.no_skip_audit }}\n        run: pnpm gate:routing-table:test", "        # It is not part of the retained no-skip target command set.\n        run: pnpm gate:routing-table:test", /exclude the exact legacy local-gate step inventory/u],
  ["extra legacy command in audit", CI, "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Agent quality-gate routing regression suite", "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Unreviewed legacy gate copy\n        run: pnpm run agent:quality-gate:test\n      - name: Agent quality-gate routing regression suite", /exclude the exact legacy local-gate step inventory/u],
  ["renamed direct legacy Bash suite", CI, "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Agent quality-gate routing regression suite", "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Renamed direct legacy gate copy\n        run: bash scripts/agent-quality-gate.test.sh\n      - name: Agent quality-gate routing regression suite", /exclude the exact legacy local-gate step inventory/u],
  ["shell-concatenated legacy alias", CI, "        run: pnpm lint:scripts", '        run: pnpm "agent:quality-"gate:test', /exclude the exact legacy local-gate step inventory/u],
  ["legacy custom shell", CI, "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Agent quality-gate routing regression suite", "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Hidden legacy custom shell\n        shell: bash scripts/agent-quality-gate.test.sh {0}\n        run: ':'\n      - name: Agent quality-gate routing regression suite", /exclude the exact legacy local-gate step inventory/u],
  ["legacy shell startup environment", CI, "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Agent quality-gate routing regression suite", "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Hidden legacy startup\n        env:\n          BASH_ENV: scripts/agent-quality-gate.test.sh\n        run: ':'\n      - name: Agent quality-gate routing regression suite", /exclude the exact legacy local-gate step inventory/u],
  ["legacy executable action input", CI, "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Agent quality-gate routing regression suite", "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Hidden legacy action\n        uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3\n        with:\n          script: execFileSync('bash', ['scripts/agent-quality-gate.test.sh'])\n      - name: Agent quality-gate routing regression suite", /exclude the exact legacy local-gate step inventory/u],
  ["legacy working-directory step", CI, "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Agent quality-gate routing regression suite", "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Hidden legacy routing parity\n        working-directory: scripts/gate/routing-table\n        run: node --test \"indexer-invariant-parity.test.mjs\"\n      - name: Agent quality-gate routing regression suite", /exclude the exact legacy local-gate step inventory/u],
  ["inherited legacy working directory", CI, "    timeout-minutes: 5\n    permissions:", "    timeout-minutes: 5\n    defaults:\n      run:\n        working-directory: scripts/gate\n    permissions:", /requires step-owned working directories/u],
  ["unreviewed step working directory", CI, "        working-directory: alerts/rules", "        working-directory: unreviewed/package", /retained package allowlist/u],
  ["retained command audit skip", CI, "      - name: Typecheck\n        run: pnpm --filter @mento-protocol/config typecheck", "      - name: Typecheck\n        if: ${{ !inputs.no_skip_audit }}\n        run: pnpm --filter @mento-protocol/config typecheck", /only pinned non-target steps may skip/u],
  ["skipped retained indexer contract", CI, "      - name: Indexer autoreview invariant contract\n        # Retained", "      - name: Indexer autoreview invariant contract\n        if: false\n        # Retained", /extracted retained contracts/u],
  ["renamed retained indexer contract", CI, "      - name: Indexer autoreview invariant contract", "      - name: Renamed indexer contract", /extracted retained contracts/u],
  ["deleted retained indexer contract", CI, "      - name: Indexer autoreview invariant contract\n        # Retained owner inventory and fail-closed schema checks. Keep this\n        # separate from the legacy routing parity suite below.\n        run: node --test scripts/agent-autoreview-indexer-invariant-contract.test.mjs\n", "", /extracted retained contracts/u],
  ["soft retained indexer contract", CI, "        run: node --test scripts/agent-autoreview-indexer-invariant-contract.test.mjs", "        continue-on-error: true\n        run: node --test scripts/agent-autoreview-indexer-invariant-contract.test.mjs", /extracted retained contracts/u],
  ["skipped retained setup contract", CI, "      - name: Agent setup and package-policy contracts\n        # Retained", "      - name: Agent setup and package-policy contracts\n        if: false\n        # Retained", /extracted retained contracts/u],
  ["renamed retained setup contract", CI, "      - name: Agent setup and package-policy contracts", "      - name: Renamed setup contract", /extracted retained contracts/u],
  ["deleted retained setup contract", CI, "      - name: Agent setup and package-policy contracts\n        # Retained SessionEnd, setup-marker, and pre-install policy checks were\n        # extracted from the legacy Bash gate suite.\n        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n", "", /extracted retained contracts/u],
  ["soft retained setup contract", CI, "        run: bash scripts/bootstrap/agent-setup-contract.test.sh", "        continue-on-error: true\n        run: bash scripts/bootstrap/agent-setup-contract.test.sh", /extracted retained contracts/u],
  ["retained command PR-only skip", CI, "      - name: Typecheck\n        run: pnpm --filter @mento-protocol/config typecheck", "      - name: Typecheck\n        if: github.event_name == 'pull_request'\n        run: pnpm --filter @mento-protocol/config typecheck", /only pinned non-target steps may skip/u],
  ["deleted retained command", CI, "      - name: Typecheck\n        run: pnpm --filter @mento-protocol/config typecheck\n", "", /retained audit workflow graph changed/u],
  ["soft-failed retained command", CI, "run: pnpm --filter @mento-protocol/config typecheck", "run: pnpm --filter @mento-protocol/config typecheck || true", /retained audit workflow graph changed/u],
  ["legacy step environment drift", CI, "        if: ${{ !inputs.no_skip_audit }}\n        run: pnpm agent:quality-gate:test", "        if: ${{ !inputs.no_skip_audit }}\n        env:\n          GATE_TEST_FOCUS: scheduler\n        run: pnpm agent:quality-gate:test", /exclude the exact legacy local-gate step inventory/u],
  ["nonblocking legacy command", CI, "        if: ${{ !inputs.no_skip_audit }}\n        run: pnpm agent:quality-gate:test", "        if: ${{ !inputs.no_skip_audit }}\n        continue-on-error: true\n        run: pnpm agent:quality-gate:test", /only the exact pinned Playwright cache steps may be nonblocking/u],
  ["nonblocking retained action", CI, "        uses: $/.github/actions/resolve-eslint-baseline\n        with:\n          package-path: shared-config", "        uses: $/.github/actions/resolve-eslint-baseline\n        continue-on-error: true\n        with:\n          package-path: shared-config", /only the exact pinned Playwright cache steps may be nonblocking/u],
  ["retained package validator skip", CI, "      - name: Validate trusted package-script pins\n        # Runs before pnpm-install because the install executes PR-authored", "      - name: Validate trusted package-script pins\n        if: ${{ !inputs.no_skip_audit }}\n        # Runs before pnpm-install because the install executes PR-authored", /retained package-script validators must remain audit-executable/u],
  ["audit changes checkout", CI, "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        if: ${{ !inputs.no_skip_audit }}\n        with:\n          persist-credentials: false", "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false", /bypass mutable change selection/u],
  ["audit paths filter", CI, "      - id: filter\n        if: ${{ !inputs.no_skip_audit }}", "      - id: filter", /bypass mutable change selection/u],
  ["candidate job checkout", CI, "          ref: ${{ inputs.no_skip_audit && inputs.audit_source_sha || github.sha }}", "          ref: ${{ github.sha }}", /exact candidate/u],
  ["candidate audit depth", CI, "          fetch-depth: ${{ inputs.no_skip_audit && '0' || '1' }}", "          fetch-depth: 1", /full audit history/u],
  ["candidate job force-all", CI, "    if: needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.shared == 'true'", "    if: needs.changes.outputs.shared == 'true'", /can skip during/u],
  ["protected self action", CI, "      - uses: $/.github/actions/pnpm-install", "      - uses: ./.github/actions/pnpm-install", /protected local actions/u],
  ["candidate-owned local action", CI, "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Agent quality-gate routing regression suite", "        run: bash scripts/bootstrap/agent-setup-contract.test.sh\n      - name: Candidate action\n        uses: ./.ci/legacy-action\n      - name: Agent quality-gate routing regression suite", /only the protected local actions/u],
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
  ["nested legacy baseline action", BASELINE, "  steps:\n    - shell: bash", "  steps:\n    - shell: bash scripts/agent-quality-gate.test.sh {0}\n      run: ':'\n    - shell: bash", /protected local action definitions/u],
  ["nested nonblocking baseline action", BASELINE, "    - shell: bash\n      env:\n        BASELINE_REF:", "    - shell: bash\n      continue-on-error: true\n      env:\n        BASELINE_REF:", /protected local action definitions/u],
];

test("the live no-skip audit satisfies its closed contract", () => {
  assert.deepEqual(noSkipAuditViolations(ROOT), []);
});

for (const [label, path, before, after, expected] of MUTATIONS) {
  test(`rejects ${label}`, () => mutateOnce(path, before, after, expected));
}

const PROTECTED_DRIFT_RUN = load(readFileSync(join(ROOT, DISPATCH), "utf8"))
  .jobs.admit.steps[2].run;

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function protectedDriftFixture(basePath) {
  const root = mkdtempSync(join(tmpdir(), "no-skip-protected-drift-"));
  git(root, "init", "--quiet");
  writeFileSync(join(root, "README.md"), "base\n");
  if (basePath) {
    mkdirSync(dirname(join(root, basePath)), { recursive: true });
    writeFileSync(join(root, basePath), "base\n");
  }
  git(root, "add", "README.md", ...(basePath ? [basePath] : []));
  git(
    root,
    "-c",
    "user.name=Audit Test",
    "-c",
    "user.email=audit@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function commitPath(root, path, content, force = false) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  git(root, "add", ...(force ? ["-f"] : []), path);
  git(
    root,
    "-c",
    "user.name=Audit Test",
    "-c",
    "user.email=audit@example.invalid",
    "commit",
    "--quiet",
    "-m",
    `change ${path}`,
  );
  return git(root, "rev-parse", "HEAD");
}

function protectedDriftResult(root, base, source) {
  return spawnSync("bash", ["-c", PROTECTED_DRIFT_RUN], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BASE_SHA: base, SOURCE_SHA: source },
  });
}

test("protected admission accepts ordinary candidate source drift", () => {
  const { root, base } = protectedDriftFixture();
  try {
    const source = commitPath(root, "src/page.ts", "export {};\n");
    assert.equal(protectedDriftResult(root, base, source).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const path of [
  ".node-version",
  "package.json",
  "nested/package.json",
  "package.json5",
  "nested/package.yaml",
  "pnpm-workspace.yaml",
  "nested/pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "nested/pnpm-lock.yaml",
  ".npmrc",
  "nested/.npmrc",
  ".pnpmfile.cjs",
  "nested/.pnpmfile.cjs",
  "pnpmfile.cjs",
  "nested/pnpmfile.cjs",
  "patches/example.patch",
  "nested/node_modules/.bin/node",
  ".github/workflows/ci.yml",
  ".github/workflows/no-skip-audit.yml",
  "scripts/workflows/check-no-skip-audit.mjs",
  "scripts/workflows/check-no-skip-audit.test.mjs",
  "scripts/lib/workflow-yaml.mjs",
  ".github/actions/pnpm-install/action.yml",
  ".github/actions/resolve-eslint-baseline/action.yml",
]) {
  test(`protected admission rejects candidate drift at ${path}`, () => {
    const { root, base } = protectedDriftFixture();
    try {
      const source = commitPath(
        root,
        path,
        "changed\n",
        path.includes("node_modules"),
      );
      const result = protectedDriftResult(root, base, source);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(path.replaceAll(".", "\\."), "u"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("protected admission rejects a tracked node_modules symlink", () => {
  const { root, base } = protectedDriftFixture();
  try {
    execFileSync("ln", ["-s", "payload", "node_modules"], { cwd: root });
    git(root, "add", "-f", "node_modules");
    git(
      root,
      "-c",
      "user.name=Audit Test",
      "-c",
      "user.email=audit@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add node_modules symlink",
    );
    const source = git(root, "rev-parse", "HEAD");
    const result = protectedDriftResult(root, base, source);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /node_modules/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ["modify", "delete", "rename", "symlink"]) {
  test(`protected admission rejects evidence-instrument ${operation}`, () => {
    const path = ".github/actions/pnpm-install/action.yml";
    const { root, base } = protectedDriftFixture(path);
    try {
      if (operation === "modify") {
        writeFileSync(join(root, path), "changed\n");
        git(root, "add", path);
      } else if (operation === "delete") git(root, "rm", path);
      else if (operation === "rename")
        git(root, "mv", path, "moved-action.yml");
      else {
        git(root, "rm", path);
        mkdirSync(dirname(join(root, path)), { recursive: true });
        execFileSync("ln", ["-s", "../../../README.md", path], { cwd: root });
        git(root, "add", path);
      }
      git(
        root,
        "-c",
        "user.name=Audit Test",
        "-c",
        "user.email=audit@example.invalid",
        "commit",
        "--quiet",
        "-m",
        operation,
      );
      const result = protectedDriftResult(
        root,
        base,
        git(root, "rev-parse", "HEAD"),
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /pnpm-install/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("rejects an audit-mode workflow that bypasses admission", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, ".github/workflows/rogue.yml"),
      'jobs:\n  audit:\n    uses: ./.github/workflows/ci.yml\n    with:\n      "no\\u005fskip\\u005faudit": true\n      "audit\\u005fsource\\u005fsha": deadbeef\n',
    );
    assert.match(
      noSkipAuditViolations(root).join("\n"),
      /only the protected dispatcher/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    implementationLines <= 250,
    `${implementationLines} implementation lines`,
  );
  assert(testLines <= 425, `${testLines} test lines`);
  assert(
    testLines <= implementationLines * 2,
    "tests exceed twice the implementation",
  );
  assert(MUTATIONS.length >= 20, `${MUTATIONS.length} focused mutations`);
});
