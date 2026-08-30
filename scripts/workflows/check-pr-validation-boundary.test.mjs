#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  M2_RECEIPT,
  checkComplexityReceipt,
  checkStructuralRepository,
  complexitySnapshot,
  hasProtectedMainSaveGuard,
} from "./check-pr-validation-boundary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "pr-validation-boundary-"));
}

function structuralFixture() {
  const root = tempRoot();
  cpSync(join(ROOT, ".github"), join(root, ".github"), { recursive: true });
  cpSync(join(ROOT, ".trunk"), join(root, ".trunk"), { recursive: true });
  return root;
}

function mutateOnce(root, path, before, after, expected) {
  const absolute = join(root, path);
  const original = readFileSync(absolute, "utf8");
  assert(original.includes(before), `${path} mutation anchor exists`);
  writeFileSync(absolute, original.replace(before, after));
  assert.match(checkStructuralRepository(root).join("\n"), expected);
  writeFileSync(absolute, original);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root, path, body) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

test("the repository satisfies the M2 structural boundary", () => {
  assert.deepEqual(checkStructuralRepository(ROOT), []);
});

test("cache saves require an exact protected-main push", () => {
  assert.equal(
    hasProtectedMainSaveGuard(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && cache != 'true'",
    ),
    true,
  );
  assert.equal(
    hasProtectedMainSaveGuard("github.ref == 'refs/heads/main'"),
    false,
  );
  assert.equal(
    hasProtectedMainSaveGuard(
      "github.event_name == 'push' || github.ref == 'refs/heads/main'",
    ),
    false,
  );
});

test("structural mutations fail closed at each M2 boundary", () => {
  const root = structuralFixture();
  assert.deepEqual(checkStructuralRepository(root), []);
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "package-manager-cache: false",
    "package-manager-cache: true",
    /disable implicit and explicit/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "        package-manager-cache: false",
    "        package-manager-cache: false\n        cache: pnpm",
    /disable implicit and explicit/u,
  );
  mutateOnce(
    root,
    ".github/workflows/code-health-duplication.yml",
    "          fetch-depth: 1\n          persist-credentials: false",
    "          fetch-depth: 1",
    /must not persist Git credentials/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "actions/cache/restore@",
    "actions/cache@",
    /monolithic actions\/cache/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "      continue-on-error: true\n      uses: actions/cache/restore@",
    "      continue-on-error: false\n      uses: actions/cache/restore@",
    /cache restore must be nonfatal/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "      continue-on-error: true\n      uses: actions/cache/save@",
    "      continue-on-error: false\n      uses: actions/cache/save@",
    /cache save must be nonfatal/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "    - name: Clear incomplete pnpm store restore\n      if: steps.pnpm-cache.outputs.cache-hit == ''",
    "    - name: Clear incomplete pnpm store restore\n      if: 'false'",
    /clear an incomplete extraction/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "      run: pnpm install --frozen-lockfile",
    "      run: echo skipped",
    /exact install command/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "    - name: Install dependencies\n      shell: bash",
    "    - name: Install dependencies\n      env:\n        CACHE_HIT: ${{ steps.pnpm-cache.outputs.cache-hit }}\n      shell: bash",
    /exact install command/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "trusted-main-v1-pnpm-store-",
    "candidate-pnpm-store-",
    /trusted-main-v1 namespace/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "        restore-keys: |\n          trusted-main-v1-pnpm-store-",
    "        restore-keys: |\n          candidate-pnpm-store-",
    /trusted-main-v1 namespace/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "github.event_name == 'push' && ",
    "",
    /exact protected-main push/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "        run: |\n          pnpm --filter @mento-protocol/indexer-envio codegen --config config.multichain.testnet.yaml",
    "        if: steps.cache.outputs.cache-hit != 'true'\n        run: |\n          pnpm --filter @mento-protocol/indexer-envio codegen --config config.multichain.testnet.yaml",
    /cache hit changes|codegen commands must run unconditionally/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      contents: read",
    "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      checks: write\n      contents: read",
    /approved PR authority/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "  guardrail-prose:\n    name: Guardrail prose pins",
    "  guardrail-prose:\n    name: Guardrail prose pins\n    env:\n      EXPANDED: ${{ secrets.EXPANDED_CREDENTIAL }}",
    /approved PR authority/u,
  );
  mutateOnce(
    root,
    ".github/workflows/lighthouse.yml",
    "    timeout-minutes: 30\n    permissions:",
    "    timeout-minutes: 30\n    env:\n      EXPANDED_CREDENTIAL: ${{ secrets.EXPANDED_CREDENTIAL }}\n    permissions:",
    /approved PR authority/u,
  );
  mutateOnce(
    root,
    ".github/workflows/aegis-terraform.yml",
    "    timeout-minutes: 15\n    permissions:\n      contents: read\n      id-token: write",
    "    timeout-minutes: 15\n    permissions:\n      contents: write\n      id-token: write",
    /approved PR authority/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "  shared:\n    name: Quality Checks (shared-config)",
    "  shared:\n    name: Quality Checks (shared-config)\n    env:\n      EXPANDED: ${{ secrets.EXPANDED_CREDENTIAL }}",
    /only nine Codecov token bindings/u,
  );
  mutateOnce(
    root,
    ".github/workflows/code-health-duplication.yml",
    "    timeout-minutes: 5\n    # Strictly advisory",
    "    timeout-minutes: 5\n    permissions:\n      checks: write\n    # Strictly advisory",
    /approved PR authority/u,
  );
  mutateOnce(
    root,
    ".github/workflows/documentation-garden.yml",
    "      - uses: actions/setup-node@",
    "      - uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9\n        with:\n          path: /tmp/cache\n          key: trusted-main-v1-unsafe\n      - uses: actions/setup-node@",
    /exact protected-main push/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      contents: read",
    "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      issues: write\n      contents: read",
    /approved PR authority/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    "          write-cache: true",
    /unconditional x64 protected-main pnpm cache writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "      - uses: ./.github/actions/pnpm-install\n      - name: Resolve main baseline (PR baseline-growth check)",
    "      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}\n      - name: Resolve main baseline (PR baseline-growth check)",
    /unconditional x64 protected-main pnpm cache writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "  production-infra-contract:\n    name: Production infrastructure contract",
    "  production-infra-contract:\n    name: Production infrastructure contract\n    if: github.event_name == 'pull_request'",
    /unconditional x64 protected-main pnpm cache writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 5\n    permissions:\n      contents: read\n      actions: read",
    "    runs-on: blacksmith-2vcpu-ubuntu-2404-arm\n    timeout-minutes: 5\n    permissions:\n      contents: read\n      actions: read",
    /unconditional x64 protected-main pnpm cache writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "codecov/codecov-action@fb8b3582c8e4def4969c97caa2f19720cb33a72f",
    "example/no-upload@fb8b3582c8e4def4969c97caa2f19720cb33a72f",
    /Codecov count/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    "  pull_request:\n    branches: [main]",
    "  pull_request:\n    branches: [main]\n    paths: [indexer-envio/**]",
    /every main pull request/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    "      pull-requests: read",
    "      pull-requests: write",
    /read-only job with pull-request access/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    "        continue-on-error: true\n        uses: dorny/paths-filter@",
    "        continue-on-error: false\n        uses: dorny/paths-filter@",
    /path filter must be nonfatal/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    'elif [[ "$FILTER_OUTCOME" != "success" ]]',
    'elif [[ "$FILTER_OUTCOME" == "success" ]]',
    /path filter must be nonfatal/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    "      - name: Publish schema diff summary\n        if: always()",
    "      - name: Publish schema diff summary\n        if: success()",
    /summary must always run/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    "readonly max_summary_bytes=60000",
    "readonly max_summary_bytes=600000",
    /60000-byte bound/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    "node scripts/schema-diff.mjs /tmp/schema-base.graphql indexer-envio/schema.graphql",
    "node scripts/schema-diff.mjs /tmp/schema-base.graphql indexer-envio/other.graphql",
    /command and advisory fallback/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    'if [[ "$PR_ACTOR" == "dependabot[bot]" ]]',
    'if [[ "$PR_ACTOR" == "renovate[bot]" ]]',
    /schema-diff fork or Dependabot exclusion/u,
  );
  mutateOnce(
    root,
    ".github/workflows/schema-diff.yml",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/github-script@3d3c42e5aac5ba805825da76410c181273ba90b1",
    /comment writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/dependabot-auto-merge.yml",
    "    if: github.event.pull_request.user.login == 'dependabot[bot]'",
    "    if: github.event.pull_request.user.login != 'dependabot[bot]'",
    /actor-gated/u,
  );
  mutateOnce(
    root,
    ".github/workflows/dependabot-auto-merge.yml",
    'run: gh pr merge --auto --squash "$PR_URL"',
    "run: pnpm test",
    /execute candidate code/u,
  );
});

test("PR-local reusable workflows stay inside the cache boundary", () => {
  const root = structuralFixture();
  const caller = join(root, ".github/workflows/code-health-duplication.yml");
  writeFileSync(
    caller,
    `${readFileSync(caller, "utf8")}\n  reusable-cache:\n    uses: ./.github/workflows/reusable-cache.yml\n`,
  );
  write(
    root,
    ".github/workflows/reusable-cache.yml",
    "name: reusable cache\non: workflow_call\njobs:\n  setup:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020\n        with:\n          node-version-file: .node-version\n",
  );
  assert.match(
    checkStructuralRepository(root).join("\n"),
    /setup-node must disable implicit and explicit/u,
  );
});

test("the M2 receipt matches fixed-base numstat and protects the Phase 0 manifest", () => {
  const root = tempRoot();
  write(
    root,
    "docs/metrics/verification-redesign-control-plane-before.json",
    "{}\n",
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  write(root, ".github/workflows/ci.yml", "name: CI\n");
  write(root, ".github/actions/install/action.yml", "name: install\n");
  write(root, ".lighthouserc.cjs", "module.exports = {};\n");
  write(
    root,
    "scripts/workflows/check-pr-validation-boundary.mjs",
    "one\ntwo\n",
  );
  write(
    root,
    "scripts/workflows/check-pr-validation-boundary.test.mjs",
    "one\ntwo\nthree\n",
  );
  write(root, "docs/adr/m2.md", "M2\n");
  assert.match(
    checkComplexityReceipt(root, base).violations.join("\n"),
    /stage untracked files/u,
  );
  git(root, ["add", "."]);
  const receipt = complexitySnapshot(root, base);
  assert(
    receipt.files.some(
      (file) =>
        file.path === "scripts/workflows/check-pr-validation-boundary.mjs",
    ),
  );
  assert.equal(
    receipt.files.find((file) => file.path === ".lighthouserc.cjs")?.category,
    "check",
  );
  write(root, M2_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  git(root, ["add", M2_RECEIPT]);
  assert.deepEqual(checkComplexityReceipt(root, base).violations, []);

  write(
    root,
    "docs/metrics/verification-redesign-control-plane-before.json",
    '{"changed":true}\n',
  );
  assert.match(
    checkComplexityReceipt(root, base).violations.join("\n"),
    /Phase 0/u,
  );
  write(
    root,
    "docs/metrics/verification-redesign-control-plane-before.json",
    "{}\n",
  );
  write(root, M2_RECEIPT, "{}\n");
  assert.match(
    checkComplexityReceipt(root, base).violations.join("\n"),
    /does not match/u,
  );
});
