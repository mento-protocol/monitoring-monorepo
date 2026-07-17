#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUDIT_DISPOSITIONS,
  buildAuditPacket,
  buildLaneShards,
  findVersionCandidates,
  renderAuditPacket,
  shardDocuments,
  weeklySelection,
} from "./docs-audit-helpers.mjs";

const scriptPath = fileURLToPath(new URL("./docs-audit.mjs", import.meta.url));

function record(file, words, lane = "operator-runbooks") {
  return {
    path: file,
    title: file,
    authority: "canonical",
    canonical: true,
    status: "active",
    owner: "eng",
    last_verified: "2026-07-17",
    doc_type: "runbook",
    garden_lane: lane,
    scope: "repo-wide",
    review_interval_days: 90,
    words,
    bytes: words * 5,
    inbound_links: 1,
  };
}

function withRepo(fn) {
  const repo = mkdtempSync(path.join(tmpdir(), "docs-audit-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  try {
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function write(repo, file, content) {
  const absolute = path.join(repo, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

test("shards at document and source-word boundaries", () => {
  const eleven = Array.from({ length: 11 }, (_, index) =>
    record(`docs/${String(index).padStart(2, "0")}.md`, 100),
  );
  assert.deepEqual(
    shardDocuments(eleven).map((shard) => shard.length),
    [10, 1],
  );
  assert.deepEqual(
    shardDocuments([record("a.md", 8_000), record("b.md", 7_000)]).map(
      (shard) => shard.reduce((total, item) => total + item.words, 0),
    ),
    [15_000],
  );
  assert.deepEqual(
    shardDocuments([record("a.md", 8_000), record("b.md", 8_000)]).map(
      (shard) => shard.length,
    ),
    [1, 1],
  );
});

test("an inherently oversized document is a singleton", () => {
  const shards = shardDocuments([
    record("a.md", 100),
    record("huge.md", 15_001),
    record("z.md", 100),
  ]);
  assert.deepEqual(
    shards.map((shard) => shard.map((item) => item.path)),
    [["a.md"], ["huge.md"], ["z.md"]],
  );
});

test("weekly selection is deterministic and explicit selection is one-based", () => {
  const laneShards = buildLaneShards([
    record("a.md", 100, "agent-entry-points"),
    record("b.md", 100, "operator-runbooks"),
    record("c.md", 100, "pr-checklists-process"),
    record("d.md", 100, "adrs-architecture"),
    record("e.md", 100, "package-readmes-reference"),
    record("f.md", 100, "notes-plans-archive"),
  ]);
  assert.deepEqual(
    weeklySelection("2026-07-17", laneShards),
    weeklySelection("2026-07-17", laneShards),
  );
  const explicit = weeklySelection("2026-07-17", laneShards, {
    lane: "operator-runbooks",
    shard: 1,
  });
  assert.equal(explicit.lane, "operator-runbooks");
  assert.equal(explicit.shardIndex, 0);
  assert.throws(
    () => weeklySelection("2026-07-17", laneShards, { lane: "missing" }),
    /unknown lane/,
  );
  assert.throws(
    () => weeklySelection("2026-02-31", laneShards),
    /invalid date/,
  );
});

test("finds bounded version-reference candidates", () => {
  const candidates = findVersionCandidates(
    "Use Terraform >= 1.11.\nOrdinary number 2.3.4.\nuses: actions/checkout@v4\n",
  );
  assert.deepEqual(candidates, [
    { line: 1, text: "Use Terraform >= 1.11." },
    { line: 3, text: "uses: actions/checkout@v4" },
  ]);
});

test("packet contains evidence fields, safety rules, and stable Markdown", () => {
  withRepo((repo) => {
    write(repo, "docs/guide.md", "# Guide\n\nUse pnpm 11.9.0.\n");
    const guide = record("docs/guide.md", 6);
    guide.inbound_links = 0;
    const inventory = {
      records: [guide],
      errors: [],
      warnings: ["docs/guide.md: example warning"],
      broken_links: [
        {
          source: "docs/guide.md",
          target: "missing.md",
          reason: "target does not exist",
        },
      ],
    };
    const packet = buildAuditPacket({
      repoRoot: repo,
      inventory,
      date: "2026-07-17",
      lane: "operator-runbooks",
      shard: 1,
      dryRun: true,
    });
    assert.equal(packet.fingerprint, "docs-garden:operator-runbooks:1-of-1");
    assert.equal(packet.dry_run, true);
    assert.deepEqual(packet.safety.allowed_dispositions, AUDIT_DISPOSITIONS);
    assert.equal(packet.context_budget.limit_bytes, 32 * 1024);
    assert.deepEqual(packet.context_budget.routes, []);
    assert.equal(packet.files[0].orphan, true);
    assert.equal(packet.files[0].metadata_warnings.length, 1);
    assert.equal(packet.files[0].broken_links.length, 1);
    assert.equal(packet.files[0].version_reference_candidates.length, 1);
    const markdown = renderAuditPacket(packet);
    assert.match(markdown, /Age is a review signal, never deletion evidence/);
    assert.match(markdown, /_required_ \| _required_/);
  });
});

test("CLI emits a dry-run JSON packet and rejects bad shards", () => {
  withRepo((repo) => {
    write(
      repo,
      "docs/guide.md",
      "---\ntitle: Guide\nstatus: active\nowner: eng\ncanonical: true\nlast_verified: 2026-07-17\ndoc_type: runbook\nscope: repo-wide\nreview_interval_days: 90\ngarden_lane: operator-runbooks\n---\n# Guide\n",
    );
    execFileSync("git", ["add", "docs/guide.md"], { cwd: repo });
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--root",
        repo,
        "--date",
        "2026-07-17",
        "--lane",
        "operator-runbooks",
        "--shard",
        "1",
        "--format",
        "json",
        "--dry-run",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).dry_run, true);
    const invalid = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--root",
        repo,
        "--lane",
        "operator-runbooks",
        "--shard",
        "2",
      ],
      { encoding: "utf8" },
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /shard must be between/);
  });
});
