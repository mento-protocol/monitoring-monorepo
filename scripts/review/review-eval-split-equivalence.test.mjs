#!/usr/bin/env node

// Re-runnable behavior proof for the review-eval module split. The checked-in
// snapshot was captured from the last monolithic Node and shell entry points.
// This suite drives the current entry points with the same frozen inputs and
// compares process output and the complete fixture-tree digest manifest.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  facadeHarnessSource,
  shellHarnessSource,
} from "./review-eval-split-equivalence-fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const splitFixtureRoot = fileURLToPath(
  new URL("./testdata/review-eval-split-equivalence", import.meta.url),
);
const contractRelative = "docs/evals/review-skill-fixtures.json";
const ledgerRelative = "docs/evals/review-skill-ledger.jsonl";
const expected = JSON.parse(
  readFileSync(path.join(splitFixtureRoot, "expected.json"), "utf8"),
);
const frozenContract = readFileSync(
  path.join(splitFixtureRoot, "contract.json.txt"),
);
const frozenLedger = readFileSync(path.join(splitFixtureRoot, "ledger.jsonl"));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeFixture(root, contractBytes, sourceLedgerBytes) {
  const state = path.join(root, "state");
  const bin = path.join(state, "bin");
  const generated = path.join(state, "generated");
  const appendedDetail = path.join(generated, "appended-detail");
  const validationDetail = path.join(generated, "validation-detail");
  const validationRow = path.join(generated, "validation-row.json");
  const facadeHarness = path.join(generated, "facade-harness.mjs");
  const shellHarness = path.join(generated, "shell-harness.sh");
  const facadeFixture = path.join(state, "facade-fixture");
  const facadePlanDir = path.join(generated, "facade-plan");
  const tmp = path.join(state, "tmp");
  mkdirSync(path.join(state, "docs/evals"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(generated, { recursive: true });
  // The appended row owns an existing but empty evidence directory. Both
  // appended validators must report the missing plan and scored files. A
  // missing plan also stops before the intentionally changed source digests
  // enter an error message, so the comparison needs no normalization.
  mkdirSync(appendedDetail, { recursive: true });
  mkdirSync(validationDetail, { recursive: true });
  mkdirSync(facadeFixture, { recursive: true });
  mkdirSync(facadePlanDir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(state, contractRelative), contractBytes);
  const [sourceRow] = String(sourceLedgerBytes)
    .split("\n")
    .filter((line) => line.trim() !== "");
  assert.ok(sourceRow, "the pre-split ledger must supply one validation row");
  const row = JSON.parse(sourceRow);
  const appendedRow = {
    ...row,
    detail_dir: "generated/appended-detail",
  };
  const validationRowValue = {
    ...row,
    detail_dir: "generated/validation-detail",
  };
  writeFileSync(
    path.join(state, ledgerRelative),
    `${JSON.stringify(appendedRow)}\n`,
  );
  writeFileSync(validationRow, `${JSON.stringify(validationRowValue)}\n`);
  // Deliberately incomplete evidence makes both validators emit stable,
  // identifiable problems without requiring a model or a complete matrix.
  writeFileSync(path.join(validationDetail, "plan.json"), "{}\n");
  writeFileSync(path.join(validationDetail, "result-probe.json"), "{}\n");
  writeFileSync(facadeHarness, facadeHarnessSource);
  writeFileSync(shellHarness, shellHarnessSource);
  chmodSync(shellHarness, 0o755);

  const gh = path.join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "\${STUB_GH_LOG:?}"
printf '[]\\n'
`,
  );
  chmodSync(gh, 0o755);

  const git = path.join(bin, "git");
  writeFileSync(
    git,
    `#!/bin/sh
printf '%s\\n' "$*" >> "\${STUB_GIT_LOG:?}"
case "$*" in
  "rev-parse --verify --quiet stub-base^{commit}")
    printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  "merge-base stub-base HEAD")
    printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  *"rev-parse --verify --quiet HEAD")
    printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
esac
exit 0
`,
  );
  chmodSync(git, 0o755);

  for (const binary of ["claude", "codex"]) {
    const stub = path.join(bin, binary);
    writeFileSync(stub, "#!/bin/sh\nexit 9\n");
    chmodSync(stub, 0o755);
  }

  return {
    state,
    bin,
    generated,
    tmp,
    validationDetail,
    validationRow,
    facadeHarness,
    facadeFixture,
    facadePlanDir,
    shellHarness,
  };
}

function normalizeStatePath(value, state) {
  return String(value).split(state).join("<STATE>");
}

function processResult(result, state) {
  return {
    status: result.status,
    signal: result.signal,
    stdout: normalizeStatePath(result.stdout, state),
    stderr: normalizeStatePath(result.stderr, state),
  };
}

function driveHarness({ sourceRoot, fixture, markerFlavor }) {
  const cli = path.join(sourceRoot, "scripts/review/review-eval.mjs");
  const runFacade = path.join(sourceRoot, "scripts/review/review-eval-run.mjs");
  const shell = path.join(sourceRoot, "scripts/review/run-eval.sh");
  const summary = path.join(fixture.generated, "step-summary.md");
  const ghLog = path.join(fixture.generated, "gh.log");
  const gitLog = path.join(fixture.generated, "git.log");
  const env = {
    ...process.env,
    GITHUB_STEP_SUMMARY: summary,
    HOME: fixture.state,
    PATH: [
      fixture.bin,
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter),
    STUB_GH_LOG: ghLog,
    STUB_GIT_LOG: gitLog,
    TMPDIR: fixture.tmp,
  };
  // A child Node process must run the CLI entry point, not inherit the parent
  // test runner's child marker and become another test worker.
  delete env.NODE_TEST_CONTEXT;

  const cases = [
    {
      name: "node help",
      result: run(process.execPath, [cli, "--help"], {
        cwd: fixture.state,
        env,
      }),
    },
    {
      name: "node argument error",
      result: run(
        process.execPath,
        [cli, "--schedule-issue", "--kind", "full"],
        {
          cwd: fixture.state,
          env,
        },
      ),
    },
    {
      // The git stub resolves a base commit whose ledger is empty. The one
      // local row is therefore appended, and its controlled evidence directory
      // is revalidated through the d9 module split.
      name: "node appended evidence validation",
      result: run(
        process.execPath,
        [
          cli,
          "--root",
          fixture.state,
          "--check-ledger",
          "--require-base",
          "--revalidate-appended",
          "--base-ref",
          "stub-base",
          "--json",
        ],
        { cwd: fixture.state, env },
      ),
    },
    {
      // This imports the compatibility facade itself. The child calls planning,
      // fixture reset, and scorePlan with the exact frozen canary matrix. With
      // no cell results, scoring must stop before the model stub runs.
      name: "node run facade domains",
      result: run(
        process.execPath,
        [
          fixture.facadeHarness,
          runFacade,
          path.join(fixture.state, contractRelative),
          fixture.facadeFixture,
          fixture.facadePlanDir,
        ],
        { cwd: fixture.state, env },
      ),
    },
    {
      // The archived wrapper carries the original marked blocks. The current
      // helper files carry the moved marked blocks. One common shell harness
      // extracts and executes each version's lifecycle support and cell
      // runtime, including a bounded command and a failed contestant cell.
      name: "shell lifecycle and cell runtime",
      result: run(
        "/bin/bash",
        [fixture.shellHarness, sourceRoot, markerFlavor, fixture.state],
        { cwd: fixture.state, env },
      ),
    },
    {
      // The existing detail directory makes modeValidate call both
      // planProvenanceProblems and runEvidenceProblems. This does not append a
      // row. It therefore does not claim equivalence for the separate
      // missing-detail semantic fix.
      name: "node evidence validation",
      result: run(
        process.execPath,
        [
          cli,
          "--root",
          fixture.state,
          "--validate",
          fixture.validationRow,
          "--detail-dir",
          fixture.validationDetail,
          "--json",
        ],
        { cwd: fixture.state, env },
      ),
    },
    {
      // This crosses the review-eval-run facade through
      // planStalenessIssueSync. The fixed date removes clock input. The gh
      // stub removes network input. This path does not emit scorer or
      // orchestrator digests, whose identities intentionally changed in the
      // split, so no output normalization can hide a behavior difference.
      name: "node scheduled issue dry-run",
      result: run(
        process.execPath,
        [
          cli,
          "--root",
          fixture.state,
          "--schedule-issue",
          "--dry-run",
          "--date",
          "2099-03-10",
          "--repo",
          "mento-protocol/monitoring-monorepo",
          "--json",
        ],
        { cwd: fixture.state, env },
      ),
    },
    {
      name: "shell help",
      result: run("/bin/bash", [shell, "--help"], {
        cwd: fixture.state,
        env,
      }),
    },
    {
      name: "shell argument error",
      result: run("/bin/bash", [shell, "--unknown"], {
        cwd: fixture.state,
        env,
      }),
    },
  ];

  assert.ok(
    existsSync(ghLog),
    `scheduled dry-run did not call the gh stub: ${JSON.stringify(
      cases.map(({ name, result }) => ({
        name,
        ...processResult(result, fixture.state),
      })),
      null,
      2,
    )}`,
  );
  assert.ok(readFileSync(ghLog, "utf8").includes("repos/mento-protocol"));
  assert.match(
    readFileSync(summary, "utf8"),
    /^review-skill eval freshness: red /,
  );
  const validation = cases.find(
    ({ name }) => name === "node evidence validation",
  )?.result;
  assert.equal(validation?.status, 1);
  const validationProblems = JSON.parse(validation.stdout).problems.join(" | ");
  assert.match(
    validationProblems,
    /row contract_digest is .*plan\.json.*planned undefined/,
  );
  assert.match(
    validationProblems,
    /result-probe\.json scoring_usd must be a nonnegative finite number/,
  );
  assert.match(validationProblems, /carries no calibration\.json/);
  const appended = cases.find(
    ({ name }) => name === "node appended evidence validation",
  )?.result;
  assert.equal(appended?.status, 1);
  const appendedOutput = JSON.parse(appended.stdout);
  assert.equal(appendedOutput.append_only_ref, "b".repeat(40));
  assert.equal(appendedOutput.revalidated_rows, 1);
  assert.match(
    appendedOutput.problems.join(" | "),
    /appended row .*carries no plan\.json.*carries no scored result-\*\.json files/,
  );
  const facade = cases.find(
    ({ name }) => name === "node run facade domains",
  )?.result;
  assert.equal(facade?.status, 0, facade?.stderr);
  const facadeOutput = JSON.parse(facade.stdout);
  assert.equal(facadeOutput.kind, "canary");
  assert.equal(facadeOutput.reset, true);
  assert.equal(facadeOutput.exec_calls, 0);
  assert.match(
    facadeOutput.score_error,
    /no completed cell results .*run the orchestrator first/,
  );
  assert.deepEqual(
    facadeOutput.git_calls.map((args) => args[0]),
    ["checkout", "reset", "clean", "rev-parse"],
  );
  const shellResult = cases.find(
    ({ name }) => name === "shell lifecycle and cell runtime",
  )?.result;
  assert.equal(shellResult?.status, 0, shellResult?.stderr);
  assert.match(shellResult.stdout, /lifecycle-bounded-status=7/);
  assert.match(shellResult.stdout, /runtime-cell-status=1/);
  assert.match(shellResult.stdout, /probe-control FAILED — claude exited 9/);
  assert.ok(readFileSync(gitLog, "utf8").includes("merge-base stub-base HEAD"));
  assert.ok(
    readFileSync(gitLog, "utf8").includes(
      "checkout --quiet --force --detach aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
  );
  return cases.map(({ name, result }) => ({
    name,
    ...processResult(result, fixture.state),
  }));
}

function snapshotFiles(root, current = root, found = {}) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      snapshotFiles(root, full, found);
      continue;
    }
    assert.equal(entry.isFile(), true, `unexpected fixture entry: ${full}`);
    const relative = path.relative(root, full);
    const normalized = normalizeStatePath(readFileSync(full, "utf8"), root);
    found[relative] = {
      executable: Boolean(statSync(full).mode & 0o111),
      sha256: sha256(normalized),
    };
  }
  return found;
}

test("review-eval entry points match the frozen pre-split behavior", (t) => {
  const workspace = realpathSync(
    mkdtempSync(path.join(tmpdir(), "review-eval-split-equivalence-")),
  );
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.equal(
    sha256(frozenContract),
    expected.source.fixture_sha256.contract,
    "the frozen split contract must match its captured digest",
  );
  assert.equal(
    sha256(frozenLedger),
    expected.source.fixture_sha256.ledger,
    "the frozen split ledger must match its captured digest",
  );

  // The process and file snapshots replace the temporary state path with one
  // marker. The result stays stable across fresh clones and temporary roots.
  const fixtureRoot = path.join(workspace, "fixture");
  const fixture = makeFixture(fixtureRoot, frozenContract, frozenLedger);
  const processes = driveHarness({
    sourceRoot: repoRoot,
    fixture,
    markerFlavor: "ORIGINAL",
  });

  assert.deepEqual(
    processes,
    expected.processes,
    "stdout, stderr, exit codes, and signals must match the frozen pre-split snapshot",
  );
  assert.deepEqual(
    snapshotFiles(fixture.state),
    expected.files,
    "every generated file and controlled input must match the frozen pre-split snapshot",
  );
});
