import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gateDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(gateDirectory, "..", "..");
const coordinatorSupport = join(
  gateDirectory,
  "quality-gate-coordinator-support.sh",
);

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`,
  );
  return result.stdout.trim();
}

async function initializeRepository(path) {
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "quality-gate@example.invalid"]);
  git(path, ["config", "user.name", "Quality Gate Test"]);
}

async function commitFile(repository, relativePath, content, message) {
  const path = join(repository, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  git(repository, ["add", relativePath]);
  git(repository, ["commit", "-qm", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

async function createFixture({ linkedWorktree = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qgc-submodules-"));
  const dependencyRoot = join(root, "dependencies");
  const dsTest = join(dependencyRoot, "ds-test");
  const forgeStd = join(dependencyRoot, "forge-std");
  const prbMath = join(dependencyRoot, "prb-math");
  const superproject = join(root, "superproject");
  const sibling = join(root, "sibling");

  await initializeRepository(dsTest);
  const dsExpected = await commitFile(
    dsTest,
    "test.sol",
    "contract DsTest {}\n",
    "ds-test expected",
  );

  await initializeRepository(forgeStd);
  await writeFile(
    join(forgeStd, ".gitmodules"),
    `[submodule "lib/ds-test"]\n\tpath = lib/ds-test\n\turl = ${dsTest}\n`,
  );
  await writeFile(join(forgeStd, "Forge.sol"), "contract Forge {}\n");
  git(forgeStd, ["add", ".gitmodules", "Forge.sol"]);
  git(forgeStd, [
    "update-index",
    "--add",
    "--cacheinfo",
    "160000",
    dsExpected,
    "lib/ds-test",
  ]);
  git(forgeStd, ["commit", "-qm", "forge expected"]);
  const forgeExpected = git(forgeStd, ["rev-parse", "HEAD"]);
  const forgeAlternate = await commitFile(
    forgeStd,
    "Forge.sol",
    "contract Forge { function changed() external {} }\n",
    "forge alternate",
  );

  await initializeRepository(prbMath);
  const prbExpected = await commitFile(
    prbMath,
    "Math.sol",
    "library Math {}\n",
    "prb expected",
  );

  await initializeRepository(superproject);
  await writeFile(join(superproject, "fixture.txt"), "fixture\n");
  await writeFile(
    join(superproject, ".gitmodules"),
    `[submodule "aegis/lib/forge-std"]\n\tpath = aegis/lib/forge-std\n\turl = ${forgeStd}\n` +
      `[submodule "aegis/lib/prb-math"]\n\tpath = aegis/lib/prb-math\n\turl = ${prbMath}\n`,
  );
  git(superproject, ["add", "fixture.txt", ".gitmodules"]);
  for (const [path, oid] of [
    ["aegis/lib/forge-std", forgeExpected],
    ["aegis/lib/prb-math", prbExpected],
  ]) {
    git(superproject, [
      "update-index",
      "--add",
      "--cacheinfo",
      "160000",
      oid,
      path,
    ]);
  }
  git(superproject, ["commit", "-qm", "superproject"]);
  if (linkedWorktree) {
    git(superproject, ["worktree", "add", "--detach", "-q", sibling, "HEAD"]);
  }

  const scratch = join(root, "scratch");
  const forgePlan = join(root, "forge-plan.tsv");
  const unrelatedPlan = join(root, "unrelated-plan.tsv");
  await mkdir(scratch);
  await writeFile(
    forgePlan,
    "quality\tcd aegis && forge test\tAegis changed\n",
  );
  await writeFile(
    unrelatedPlan,
    "quality\tpnpm lint:scripts\tscript changed\n",
  );
  return {
    dependencyRoot,
    forgeAlternate,
    forgeExpected,
    forgePlan,
    forgeStd,
    prbMath,
    root,
    scratch,
    sibling,
    superproject,
    unrelatedPlan,
  };
}

async function initializeSubmodules(
  fixture,
  worktree,
  { nested = false } = {},
) {
  await mkdir(join(worktree, "aegis", "lib"), { recursive: true });
  git(worktree, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "aegis/lib/forge-std",
    "aegis/lib/prb-math",
  ]);
  if (nested) {
    git(join(worktree, "aegis", "lib", "forge-std"), [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
    ]);
  }
}

function submoduleHash(fixture, worktree, plan = fixture.forgePlan) {
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      `
        set -uo pipefail
        source "$1"
        repo_root="$2"
        scratch_dir="$3"
        hash_stream() { git hash-object --stdin; }
        gate_coordinator_submodule_state_hash "$4"
      `,
      "quality-gate-submodule-test",
      coordinatorSupport,
      worktree,
      fixture.scratch,
      plan,
    ],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
  );
}

function successfulHash(fixture, worktree, plan = fixture.forgePlan) {
  const result = submoduleHash(fixture, worktree, plan);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^[a-f0-9]{40}$/u);
  return result.stdout.trim();
}

test("submodule state is plan-aware and binds missing and uninitialized checkouts", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const unusedMissing = successfulHash(
    fixture,
    fixture.superproject,
    fixture.unrelatedPlan,
  );
  const missing = successfulHash(fixture, fixture.superproject);
  await mkdir(join(fixture.superproject, "aegis", "lib", "forge-std"), {
    recursive: true,
  });
  await mkdir(join(fixture.superproject, "aegis", "lib", "prb-math"));
  const uninitialized = successfulHash(fixture, fixture.superproject);
  assert.notEqual(uninitialized, missing);
  assert.equal(
    successfulHash(fixture, fixture.superproject, fixture.unrelatedPlan),
    unusedMissing,
  );

  await writeFile(
    join(fixture.superproject, "aegis", "lib", "forge-std", "manual.sol"),
    "contract Manual {}\n",
  );
  const populated = submoduleHash(fixture, fixture.superproject);
  assert.notEqual(populated.status, 0);
  assert.match(
    populated.stderr,
    /uninitialized Aegis submodule path is not empty/u,
  );
});

test("clean checkout identity is bound and dirty or hidden states fail closed", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await initializeSubmodules(fixture, fixture.superproject);

  const expected = successfulHash(fixture, fixture.superproject);
  const forgeCheckout = join(fixture.superproject, "aegis", "lib", "forge-std");
  git(forgeCheckout, ["checkout", "--detach", "-q", fixture.forgeAlternate]);
  assert.notEqual(successfulHash(fixture, fixture.superproject), expected);
  git(forgeCheckout, ["checkout", "--detach", "-q", fixture.forgeExpected]);

  await writeFile(
    join(forgeCheckout, "Forge.sol"),
    "contract Forge { function dirty() external {} }\n",
  );
  let rejected = submoduleHash(fixture, fixture.superproject);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Aegis submodule checkout is dirty/u);

  git(forgeCheckout, ["add", "Forge.sol"]);
  rejected = submoduleHash(fixture, fixture.superproject);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Aegis submodule checkout is dirty/u);
  git(forgeCheckout, ["restore", "--staged", "--worktree", "Forge.sol"]);

  await writeFile(join(forgeCheckout, "untracked.sol"), "contract Extra {}\n");
  rejected = submoduleHash(fixture, fixture.superproject);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Aegis submodule checkout is dirty/u);

  await rm(join(forgeCheckout, "untracked.sol"));
  git(forgeCheckout, ["update-index", "--assume-unchanged", "Forge.sol"]);
  await writeFile(
    join(forgeCheckout, "Forge.sol"),
    "contract Forge { function hidden() external {} }\n",
  );
  rejected = submoduleHash(fixture, fixture.superproject);
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /Aegis submodule checkout has hidden index state/u,
  );
});

test("recursive state is bound without physical worktree paths", async (t) => {
  const fixture = await createFixture({ linkedWorktree: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await initializeSubmodules(fixture, fixture.superproject);
  const nestedMissing = successfulHash(fixture, fixture.superproject);
  await initializeSubmodules(fixture, fixture.superproject, { nested: true });
  const nestedInitialized = successfulHash(fixture, fixture.superproject);
  assert.notEqual(nestedInitialized, nestedMissing);

  await initializeSubmodules(fixture, fixture.sibling, { nested: true });
  assert.equal(
    successfulHash(fixture, fixture.sibling),
    nestedInitialized,
    "equivalent clean linked worktrees must share a submodule identity",
  );

  const nestedCheckout = join(
    fixture.superproject,
    "aegis",
    "lib",
    "forge-std",
    "lib",
    "ds-test",
  );
  git(nestedCheckout, ["update-index", "--skip-worktree", "test.sol"]);
  await rm(join(nestedCheckout, "test.sol"));
  const rejected = submoduleHash(fixture, fixture.superproject);
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /Aegis submodule checkout has hidden index state/u,
  );
});

test("execution and HEAD-compatible freshness fingerprints include submodule state", () => {
  const support = readFileSync(coordinatorSupport, "utf8");
  const gate = readFileSync(
    join(repositoryRoot, "scripts", "agent-quality-gate.sh"),
    "utf8",
  );
  assert.match(
    support,
    /gate_coordinator_recompute_fingerprint\(\)[\s\S]*gate_coordinator_submodule_state_hash "\$fresh_plan"[\s\S]*"submodules=\$\{submodule_state\}"/u,
  );
  assert.match(
    gate,
    /gate_coordinator_freshness_context_hash\(\)[\s\S]*gate_coordinator_submodule_state_hash "\$command_plan_file"[\s\S]*"submodules=\$\{submodule_state\}"/u,
  );
});

test("production Aegis submodule paths and Forge plan selector match repository contracts", () => {
  const support = readFileSync(coordinatorSupport, "utf8");
  const fixedPathMatch = support.match(
    /^\s*for path in ((?:aegis\/lib\/[A-Za-z0-9._-]+\s*)+); do$/mu,
  );
  assert.ok(
    fixedPathMatch,
    "production Aegis submodule paths must be explicit",
  );
  const fixedPaths = fixedPathMatch[1].trim().split(/\s+/u).sort();
  const trackedPaths = git(repositoryRoot, [
    "ls-files",
    "--stage",
    "--",
    "aegis/lib",
  ])
    .split("\n")
    .flatMap((line) => {
      const match = line.match(
        /^160000 [a-f0-9]{40}(?:[a-f0-9]{24})? 0\t(aegis\/lib\/[^/]+)$/u,
      );
      return match ? [match[1]] : [];
    })
    .sort();
  assert.deepEqual(fixedPaths, trackedPaths);
  assert.match(
    support,
    /awk -F '\\t' '\$2 == "cd aegis && forge test" \{ print "yes"; exit \}' "\$plan_file"/u,
  );
});
