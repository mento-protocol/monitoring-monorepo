import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { runAuditedProbe } from "./review-eval-v2-probe-trust.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  loadDataset,
  rootsForCase,
  validateDataset,
  verifyCaseProbes,
} from "./review-eval-v2-dataset.mjs";

const file = fileURLToPath(
  new URL("../../docs/evals/review-skill-v2/dataset.json", import.meta.url),
);
const rootDir = path.dirname(file);
const fresh = () => JSON.parse(readFileSync(file, "utf8"));
const check = (dataset) => validateDataset({ dataset, rootDir });

test("audited pilot contains four cases, three roots and pinned repair bytes", () => {
  const { dataset, digest } = loadDataset({ file });
  assert.equal(dataset.cases.length, 4);
  assert.equal(dataset.roots.length, 3);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(check(dataset), []);
  assert.equal(rootsForCase(dataset, "pr-1982-original").length, 2);
  assert.deepEqual(
    rootsForCase(dataset, "pr-1982-repaired"),
    rootsForCase(dataset, "pr-1982-original"),
  );
  assert.equal(rootsForCase(dataset, "pr-1984-repaired").length, 1);
  assert.throws(() => rootsForCase(dataset, "unknown"), /Unknown case/);
});

test("original and repaired cases cannot leak across splits or source heads", () => {
  const data = fresh();
  data.cases[1].split = "confirmation";
  assert.ok(
    check(data).some((message) => message.includes("PR crosses splits")),
  );
  data.cases[1].split = "development";
  data.cases[1].first_head = "a".repeat(40);
  assert.ok(
    check(data).some((message) => message.includes("inconsistent first_head")),
  );
});

test("family aliases cannot bypass the PR-level split", () => {
  const data = fresh();
  const copies = structuredClone(data.cases.slice(0, 2));
  for (const item of copies) {
    item.id += "-copy";
    item.family_id += "-copy";
    item.split = "confirmation";
  }
  data.cases.push(...copies);
  assert.ok(
    check(data).some((message) => message.includes("PR crosses splits")),
  );
});

test("labels must be partial and agent-audited with source provenance", () => {
  const data = fresh();
  data.labels_complete = true;
  data.roots[0].label_authority = "human";
  data.roots[0].source_finding_ids = [];
  const errors = check(data);
  assert.ok(errors.some((message) => message.includes("partial labels")));
  assert.ok(errors.some((message) => message.includes("label authority")));
  assert.ok(errors.some((message) => message.includes("source finding")));
});

test("unknown, duplicate, foreign and orphan roots fail validation", () => {
  const data = fresh();
  data.cases[0].expected_root_ids.push(
    "claim-optional-branch",
    "unknown",
    "unknown",
  );
  assert.ok(
    check(data).some((message) =>
      message.includes("invalid expected_root_ids"),
    ),
  );
  data.cases[0].expected_root_ids = ["unknown"];
  assert.ok(
    check(data).some((message) => message.includes("unknown or foreign root")),
  );
  assert.ok(check(data).some((message) => message.includes("orphan root")));
});

test("repair bytes and corresponding negative roots cannot drift", () => {
  const data = fresh();
  data.cases[1].repair.sha256 = "0".repeat(64);
  data.cases[1].negative_control_root_ids = [];
  const errors = check(data);
  assert.ok(
    errors.some((message) => message.includes("repair digest mismatch")),
  );
  assert.ok(errors.some((message) => message.includes("repair roots differ")));
});

test("repair symlinks cannot escape dataset directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-v2-dataset-"));
  try {
    const nested = path.join(dir, "dataset");
    mkdirSync(nested);
    writeFileSync(path.join(dir, "outside.patch"), "outside");
    symlinkSync(
      path.join(dir, "outside.patch"),
      path.join(nested, "repair.patch"),
    );
    const data = fresh();
    data.cases[1].repair.file = "repair.patch";
    const errors = validateDataset({ dataset: data, rootDir: nested });
    assert.ok(errors.some((message) => message.includes("repair escapes")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed label objects and missing arrays produce validation errors", () => {
  const data = fresh();
  data.roots.push(null);
  data.cases.push(null);
  data.roots[0].locations = [null];
  data.cases[0].expected_root_ids = null;
  const errors = check(data);
  assert.ok(errors.includes("invalid root object"));
  assert.ok(errors.includes("invalid case object"));
  assert.ok(
    errors.some((message) => message.includes("invalid source locations")),
  );
});

test("one harvested finding cannot count toward two root causes", () => {
  const data = fresh();
  data.roots[1].source_finding_ids.push(data.roots[0].source_finding_ids[0]);
  assert.ok(
    check(data).some((message) => message.includes("repeated source finding")),
  );
});

test("missing IDs cannot pass through regular-expression string coercion", () => {
  const data = fresh();
  delete data.cases[0].id;
  assert.ok(
    check(data).some((message) =>
      message.includes("duplicate or invalid case"),
    ),
  );
});

// Byte-exact snapshots keep these tests independent of historical Git objects.
// The production probe guard verifies every copied module against its audit pin.
const probeFixtureRoot = fileURLToPath(
  new URL("./fixtures/v2-probes/", import.meta.url),
);
const probeModules = {
  1984: [
    "scripts/sentry/autofix/sentry-autofix-run-record.mjs",
    "scripts/sentry/autofix/sentry-autofix-refused-inventory.mjs",
  ],
  1982: [
    "scripts/pr/issue-board-backfill.mjs",
    "scripts/pr/issue-board-state.mjs",
  ],
};
function trustedFixture(context, item) {
  const fixturePath = mkdtempSync(
    path.join(os.tmpdir(), "v2-audited-fixture-"),
  );
  context.after(() => rmSync(fixturePath, { recursive: true, force: true }));
  for (const module of probeModules[item.pr]) {
    const target = path.join(fixturePath, module);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(
        path.join(
          probeFixtureRoot,
          `pr-${item.pr}`,
          `${path.basename(module)}.txt`,
        ),
      ),
    );
  }
  if (item.repair)
    execFileSync("git", ["apply", path.join(rootDir, item.repair.file)], {
      cwd: fixturePath,
    });
  return fixturePath;
}

test("dataset source and repair authority comes from the audited registry", () => {
  for (const [field, value] of [
    ["first_head", "1".repeat(40)],
    ["base_sha", "2".repeat(40)],
    ["pr", 1999],
  ]) {
    const dataset = fresh();
    dataset.cases[0][field] = value;
    assert.ok(
      check(dataset).some((message) =>
        message.includes(`unaudited probe ${field}`),
      ),
    );
  }
  const dataset = fresh();
  dataset.repo = "attacker/fixture";
  assert.ok(
    check(dataset).some((message) =>
      message.includes("outside the audited pilot registry"),
    ),
  );
  dataset.repo = fresh().repo;
  dataset.cases[1].repair.sha256 = "f".repeat(64);
  assert.ok(
    check(dataset).some((message) =>
      message.includes("unaudited probe repair"),
    ),
  );
});

test("direct probe helper rejects substituted entry and transitive modules before initialization", (context) => {
  const dataset = fresh();
  const item = dataset.cases.find((entry) => entry.id === "pr-1984-original");
  for (const module of probeModules[item.pr]) {
    const fixturePath = trustedFixture(context, item);
    const marker = path.join(fixturePath, "marker.json");
    const target = path.join(fixturePath, module);
    writeFileSync(
      target,
      `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n` +
        readFileSync(target, "utf8"),
    );
    assert.throws(
      () => verifyCaseProbes({ fixturePath, caseId: item.id, dataset }),
      /unaudited probe module bytes/,
    );
    assert.equal(existsSync(marker), false);
  }
});

test("direct probe helper enforces source authority without the dataset loader", (context) => {
  const dataset = fresh();
  const item = dataset.cases[0];
  const fixturePath = trustedFixture(context, item);
  dataset.repo = "attacker/fixture";
  assert.throws(
    () => verifyCaseProbes({ fixturePath, caseId: item.id, dataset }),
    /outside the audited pilot registry/,
  );
});

test("trusted original and repaired probes execute unchanged audited bytes", (context) => {
  const dataset = fresh();
  for (const item of dataset.cases) {
    const fixturePath = trustedFixture(context, item);
    const before = probeModules[item.pr].map((module) =>
      readFileSync(path.join(fixturePath, module), "utf8"),
    );
    const result = verifyCaseProbes({ fixturePath, caseId: item.id, dataset });
    assert.equal(result.status, "passed");
    for (const id of item.expected_root_ids)
      assert.equal(result.defects_present[id], true);
    for (const id of item.negative_control_root_ids)
      assert.equal(result.defects_present[id], false);
    assert.deepEqual(
      probeModules[item.pr].map((module) =>
        readFileSync(path.join(fixturePath, module), "utf8"),
      ),
      before,
    );
  }
});

test("probe snapshots exclude inherited loader configuration and environment", (context) => {
  const dataset = fresh();
  const item = dataset.cases[0];
  const fixturePath = trustedFixture(context, item);
  const marker = path.join(fixturePath, "loader-marker");
  const loader = path.join(fixturePath, "preload.mjs");
  writeFileSync(
    loader,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  );
  const oldOptions = process.env.NODE_OPTIONS;
  const oldSentinel = process.env.REVIEW_V2_SAFE_SENTINEL;
  try {
    process.env.NODE_OPTIONS = `--import=${loader}`;
    process.env.REVIEW_V2_SAFE_SENTINEL = "probe-child-must-not-inherit";
    const result = runAuditedProbe({
      repo: dataset.repo,
      item,
      fixturePath,
      script:
        "console.log(JSON.stringify({inherited:process.env.REVIEW_V2_SAFE_SENTINEL??null,options:process.env.NODE_OPTIONS??null}));",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      inherited: null,
      options: null,
    });
    assert.equal(existsSync(marker), false);
    assert.equal(
      verifyCaseProbes({ fixturePath, caseId: item.id, dataset }).status,
      "passed",
    );
  } finally {
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldOptions;
    if (oldSentinel === undefined) delete process.env.REVIEW_V2_SAFE_SENTINEL;
    else process.env.REVIEW_V2_SAFE_SENTINEL = oldSentinel;
  }
});
