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
  authorityInventory,
  checkStructuralRepository,
} from "./check-pr-validation-boundary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function structuralFixture() {
  const root = mkdtempSync(join(tmpdir(), "pr-validation-boundary-"));
  cpSync(join(ROOT, ".github"), join(root, ".github"), { recursive: true });
  cpSync(join(ROOT, ".trunk"), join(root, ".trunk"), { recursive: true });
  // prettier-ignore
  for (const path of ["pnpm-workspace.yaml", "governance-watchdog/pnpm-workspace.yaml", "alerts/infra/oncall-announcer/pnpm-workspace.yaml", "alerts/infra/onchain-event-handler/pnpm-workspace.yaml"]) { mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(join(ROOT, path), join(root, path)); }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
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

test("a HOME override cannot put the pnpm cache inside the checkout", () => {
  const root = structuralFixture();
  const action = load(
    readFileSync(join(root, ".github/actions/pnpm-install/action.yml"), "utf8"),
  );
  const verify = action.runs.steps.find(
    (step) => step.name === "Verify pnpm store target",
  );
  const result = spawnSync("bash", ["-c", verify.run], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: root, HOME: root },
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /inside source checkout/u);
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
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "      continue-on-error: true\n      uses: actions/cache/restore@", "      continue-on-error: false\n      uses: actions/cache/restore@", /cache restore must be nonfatal/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "      continue-on-error: true\n      uses: actions/cache/save@", "      continue-on-error: false\n      uses: actions/cache/save@", /cache save must be nonfatal/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "    - name: Clear incomplete pnpm store restore\n      if: steps.pnpm-cache.outputs.cache-hit == ''", "    - name: Clear incomplete pnpm store restore\n      if: 'false'", /clear an incomplete extraction/u);
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "      run: pnpm install --frozen-lockfile --store-dir ~/pnpm-store",
    "      run: echo skipped",
    /exact install command/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "pnpm install --frozen-lockfile --ignore-scripts --lockfile-dir . --store-dir ~/pnpm-store",
    "pnpm install --frozen-lockfile --ignore-scripts --lockfile-dir .",
    /three package-local installs/u,
  );
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "        dest: ~/pnpm-home", "        dest: ~/other", /pin one home-relative PNPM_HOME/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0", "    - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9\n      with:\n        dest: ~/pnpm-home\n    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0", /pin one home-relative PNPM_HOME/u);
  // prettier-ignore
  mutateOnce(root, "pnpm-workspace.yaml", "packages:", "storeDir: /tmp/other\npackages:", /store override is forbidden/u);
  // prettier-ignore
  mutateOnce(root, "governance-watchdog/pnpm-workspace.yaml", "packages:", "store-dir: /tmp/other\npackages:", /store override is forbidden/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "        run: pnpm tf:test", "        env:\n          PNPM_CONFIG_STORE_DIR: /tmp/other\n        run: pnpm tf:test", /store override is forbidden/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "        run: pnpm tf:test", "        run: pnpm --store-dir /tmp/other tf:test", /store override is forbidden/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "        run: pnpm tf:test", "        run: pnpm config set store_dir /tmp/other\n          pnpm tf:test", /store override is forbidden/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "        run: pnpm tf:test", "        env:\n          PNPM_HOME: /tmp/other\n        run: pnpm tf:test", /store override is forbidden/u);
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "        path: ~/pnpm-store",
    "        path: ~/.local/share/pnpm/store",
    /pinned home-relative store/u,
  );
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "      uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0", "      uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0", /one restore and one protected-main save/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "    - name: Clear incomplete pnpm store restore", "    - name: Duplicate pnpm restore\n      continue-on-error: true\n      uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n      with:\n        path: ~/pnpm-store\n        key: trusted-main-v1-pnpm-store-duplicate\n    - name: Clear incomplete pnpm store restore", /one restore and one protected-main save/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "    - name: Save pnpm store", "    - name: Duplicate pnpm save\n      if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n      continue-on-error: true\n      uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n      with:\n        path: ~/pnpm-store\n        key: trusted-main-v1-pnpm-store-duplicate\n    - name: Save pnpm store", /one restore and one protected-main save/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "    - name: Install dependencies", "    - name: Clear incomplete pnpm store restore\n      if: steps.pnpm-cache.outputs.cache-hit == ''\n      shell: bash\n      run: echo duplicate\n    - name: Install dependencies", /one cleanup/u);
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "    - name: Prepare pnpm store target",
    "    - name: Skip pnpm store preparation",
    /cleared exactly once/u,
  );
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "    - name: Clear incomplete pnpm store restore",
    '    - name: Mutate later steps\n      shell: bash\n      run: echo "NODE_OPTIONS=--import=./evil.mjs" >> "$GITHUB_ENV"\n    - name: Clear incomplete pnpm store restore',
    /without mutating the later-step environment/u,
  );
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", 'const target = join(realpathSync(homedir()), "pnpm-store")', 'const target = join(realpathSync(homedir()), "other")', /pin one home-relative PNPM_HOME/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "    - name: Prepare pnpm store target", "    - name: Verify pnpm store target\n      shell: bash\n      run: echo duplicate\n    - name: Prepare pnpm store target", /pin one home-relative PNPM_HOME/u);
  mutateOnce(
    root,
    ".github/actions/pnpm-install/action.yml",
    "    - name: Save pnpm store",
    "    - name: Install dependencies\n      shell: bash\n      run: pnpm install --frozen-lockfile --store-dir ~/pnpm-store\n    - name: Save pnpm store",
    /pin one home-relative PNPM_HOME/u,
  );
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "'pnpm-lock.yaml', 'pnpm-workspace.yaml'", "'pnpm-lock.yaml'", /matching toolchain-bound key/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/pnpm-install/action.yml", "    - name: Install dependencies\n      shell: bash", "    - name: Install dependencies\n      continue-on-error: true\n      shell: bash", /required steps unconditional and fatal/u);
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
    "          trusted-main-v1-pnpm-store-${{ runner.os }}-${{ runner.arch }}-",
    "          trusted-main-v1-pnpm-store-${{ runner.os }}-",
    /matching toolchain-bound key/u,
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
    "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      contents: read",
    "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      checks: write\n      contents: read",
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
    "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      contents: read",
    "  shared:\n    name: Quality Checks (shared-config)\n    needs: changes\n    if: needs.changes.outputs.forceAll == 'true' || needs.changes.outputs.shared == 'true'\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 10\n    permissions:\n      issues: write\n      contents: read",
    /approved PR authority/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    "          write-cache: true",
    /dependency-free x64 pnpm cache writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "      - name: Validate trusted package-script pins\n        # Runs before pnpm-install because the install executes PR-authored\n        # lifecycle hooks. It also pins the tf:test and issue:board:test aliases\n        # before this required job trusts them.\n        run: node scripts/check-agent-quality-gate-package-scripts.mjs\n",
    "",
    /dependency-free package-script validator/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "      - name: Validate trusted package-script pins\n        # Runs before pnpm-install because the install executes PR-authored\n        # lifecycle hooks. It also pins the tf:test and issue:board:test aliases\n        # before this required job trusts them.\n        run: node scripts/check-agent-quality-gate-package-scripts.mjs\n",
    "      - name: Validate trusted package-script pins\n        # Runs before pnpm-install because the install executes PR-authored\n        # lifecycle hooks. It also pins the tf:test and issue:board:test aliases\n        # before this required job trusts them.\n        run: node scripts/check-agent-quality-gate-package-scripts.mjs\n      - name: Validate trusted package-script pins\n        run: node scripts/check-agent-quality-gate-package-scripts.mjs\n",
    /exactly one dependency-free package-script validator/u,
  );
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "        # before this required job trusts them.\n        run: node scripts/check-agent-quality-gate-package-scripts.mjs", "        # before this required job trusts them.\n        run: node scripts/check-agent-quality-gate-package-scripts.mjs --skip", /trusted package-script pin check/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "  production-infra-contract:\n    name: Production infrastructure contract", "  production-infra-contract:\n    name: Production infrastructure contract\n    needs: changes", /direct dependency-free x64 pnpm cache writer/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", "      - uses: ./.github/actions/pnpm-install\n        if: 'false'\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", /dependency-free x64 pnpm cache writer/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", "      - uses: ./.github/actions/pnpm-install\n        env:\n          PNPM_CONFIG_STORE_DIR: /tmp/other\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", /store override is forbidden/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", "      - name: Persist alternate pnpm store\n        run: echo \"PNPM_CONFIG_STORE_DIR=/tmp/other\" >> \"$GITHUB_ENV\"\n      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", /store override is forbidden/u);
  // prettier-ignore
  mutateOnce(root, ".github/workflows/ci.yml", "  production-infra-contract:\n    name: Production infrastructure contract", "  production-infra-contract:\n    name: Production infrastructure contract\n    container: node:24", /caller jobs must not use containers/u);
  // prettier-ignore
  mutateOnce(root, ".github/actions/resolve-eslint-baseline/action.yml", "        set -euo pipefail", "        set -euo pipefail\n        echo \"PNPM_CONFIG_STORE_DIR=/tmp/other\" >> \"$GITHUB_ENV\"", /store override is forbidden/u);
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "      - uses: ./.github/actions/pnpm-install\n      - name: Resolve main baseline (PR baseline-growth check)",
    "      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}\n      - name: Resolve main baseline (PR baseline-growth check)",
    /dependency-free x64 pnpm cache writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "  production-infra-contract:\n    name: Production infrastructure contract",
    "  production-infra-contract:\n    name: Production infrastructure contract\n    if: github.event_name == 'pull_request'",
    /dependency-free x64 pnpm cache writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/ci.yml",
    "    runs-on: blacksmith-2vcpu-ubuntu-2404\n    timeout-minutes: 5\n    permissions:\n      contents: read\n      actions: read",
    "    runs-on: blacksmith-2vcpu-ubuntu-2404-arm\n    timeout-minutes: 5\n    permissions:\n      contents: read\n      actions: read",
    /dependency-free x64 pnpm cache writer/u,
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
    ".github/workflows/dependabot-auto-merge-candidate.yml",
    "    permissions:\n      contents: read\n      pull-requests: read",
    "    permissions:\n      contents: write\n      pull-requests: write",
    /combined contents: write and pull-requests: write outside the exact Dependabot writer/u,
  );
  mutateOnce(
    root,
    ".github/workflows/dependabot-auto-merge-candidate.yml",
    "      github.actor == 'dependabot[bot]'",
    "      github.actor != 'dependabot[bot]'",
    /exact reviewed Dependabot auto-merge workflow pair inventory/u,
  );
  mutateOnce(
    root,
    ".github/workflows/dependabot-auto-merge.yml",
    ".run_attempt == 1 and",
    ".run_attempt > 0 and",
    /exact reviewed Dependabot auto-merge workflow pair inventory/u,
  );
  write(root, ".npmrc", "store-dir=/tmp/other\n");
  assert.match(
    checkStructuralRepository(root).join("\n"),
    /store override is forbidden/u,
  );
});

test("Dependabot auto-merge workflows may be absent only as one pair", () => {
  const root = structuralFixture();
  try {
    rmSync(join(root, ".github/workflows/dependabot-auto-merge-candidate.yml"));
    assert.deepEqual(checkStructuralRepository(root), [
      "the Dependabot auto-merge classifier and writer workflows must be present or absent as one reviewed pair",
    ]);
    rmSync(join(root, ".github/workflows/dependabot-auto-merge.yml"));
    assert.deepEqual(checkStructuralRepository(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR-local reusable workflows stay inside cache and authority boundaries", () => {
  const root = structuralFixture();
  const caller = join(root, ".github/workflows/code-health-duplication.yml");
  writeFileSync(
    caller,
    `${readFileSync(caller, "utf8")}\n  reusable-cache:\n    uses: ./.github/workflows/reusable-cache.yml\n`,
  );
  write(
    root,
    ".github/workflows/reusable-cache.yml",
    "name: reusable cache\non: workflow_call\njobs:\n  setup:\n    runs-on: ubuntu-latest\n    permissions:\n      issues: write\n    steps:\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020\n        with:\n          node-version-file: .node-version\n",
  );
  const violations = checkStructuralRepository(root).join("\n");
  assert.match(violations, /setup-node must disable implicit and explicit/u);
  assert.match(violations, /approved PR authority/u);
  assert(
    authorityInventory(root).includes(
      'reusable-cache.yml|setup|{"issues":"write"}|[]|null|null|null',
    ),
  );
});

test("the permanent CLI ignores later product files and the retired M2 base", () => {
  const root = structuralFixture();
  write(root, "ui-dashboard/src/later-page.tsx", "export default null;\n");
  git(root, ["add", "."]);
  assert.throws(() =>
    execFileSync(
      "git",
      ["cat-file", "-e", "ccef910fa6fc267751681176ffdeef01daf90b40^{commit}"],
      { cwd: root, stdio: "ignore" },
    ),
  );
  const output = execFileSync(
    process.execPath,
    [join(ROOT, "scripts/workflows/check-pr-validation-boundary.mjs")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(output, "PR validation trust contract passes.\n");
});
