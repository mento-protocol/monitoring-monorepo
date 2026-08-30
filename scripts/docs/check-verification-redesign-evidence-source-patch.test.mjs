#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const metrics = join(repoRoot, "docs/metrics");
const json = (name) => JSON.parse(fs.readFileSync(join(metrics, name), "utf8"));
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
const ancestor = (from, to) =>
  git(repoRoot, "merge-base", "--is-ancestor", from, to);
test("retained source patch matches metadata and reproduces the measured tree", () => {
  const record = json(
    "verification-redesign-local-gate-source-bound-sample.json",
  );
  const baseline = json("verification-redesign-baseline.json").local_gate
    .source_bound_sample;
  const replay = record.reproducibility;
  assert.equal(
    `${replay.reproduction_base_is_reachable_from_current_main}:${replay.fresh_clone_replay_verified}:${replay.matches_measured_head_tree}:${record.result}`,
    "true:true:true:pass",
  );
  const shas = [
    replay.reproduction_base_sha,
    replay.rebased_patch_base_sha,
    replay.reproduced_tree_sha,
    record.source.head_tree_sha,
    record.source.index_tree_before_sha,
    record.source.index_tree_after_sha,
  ];
  assert.ok(shas.every((sha) => /^[0-9a-f]{40}$/u.test(sha)));
  const artifact = "docs/metrics/verification-redesign-local-gate-source.patch";
  assert.equal(replay.patch_artifact, artifact);
  const patchPath = resolve(repoRoot, replay.patch_artifact);
  const patch = fs.readFileSync(patchPath);
  assert.equal(patch.byteLength, replay.patch_bytes);
  assert.equal(
    patch.reduce((lines, byte) => lines + Number(byte === 0x0a), 0),
    replay.patch_lines,
  );
  assert.equal(
    createHash("sha256").update(patch).digest("hex"),
    replay.patch_sha256,
  );
  ancestor(replay.reproduction_base_sha, replay.rebased_patch_base_sha);
  ancestor(replay.rebased_patch_base_sha, "HEAD");
  const scratch = fs.mkdtempSync(join(tmpdir(), "verification-source-patch-"));
  try {
    const clone = join(scratch, "repo");
    execFileSync("git", ["clone", "-q", "-s", "-n", repoRoot, clone]);
    git(clone, "read-tree", replay.reproduction_base_sha);
    const apply = [
      "apply",
      "--cached",
      "--binary",
      "--whitespace=nowarn",
      "--",
      patchPath,
    ];
    git(clone, ...apply);
    const tree = git(clone, "write-tree").trim();
    assert.ok(shas.slice(2).every((sha) => sha === tree));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.deepEqual(
    [
      baseline.patch_artifact,
      baseline.patch_sha256,
      baseline.measured_source_sha,
      baseline.reproduced_tree_sha,
      baseline.fresh_clone_replay_verified,
      baseline.result,
    ],
    [
      replay.patch_artifact,
      replay.patch_sha256,
      record.source.head_sha,
      replay.reproduced_tree_sha,
      replay.fresh_clone_replay_verified,
      record.result,
    ],
  );
});
