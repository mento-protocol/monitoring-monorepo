import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  loadDataset,
  rootsForCase,
  validateDataset,
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
