#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [DEFAULT_INVENTORY, DEFAULT_MANIFEST] = [
  "verification-redesign-safeguards.jsonl",
  "verification-redesign-control-plane-before.json",
].map((name) => resolve(DEFAULT_ROOT, "docs/metrics", name));
export const DISPOSITION_FIELDS = Object.freeze({
  "retained-required-ci": "entry_point",
  "retained-author-procedure": "entry_point",
  "retained-after-merge": "entry_point",
  scheduled: "detection_interval",
  duplicate: "duplicate_of",
  "obsolete-with-evidence": "evidence",
  "deferred-with-owner": "follow_up",
});
const DISPOSITION_EVIDENCE_FIELDS = new Set(Object.values(DISPOSITION_FIELDS));
const RETAINED = new Set(Object.keys(DISPOSITION_FIELDS).slice(0, 3));
const REQUIRED_RISKS = new Set(Array.from({ length: 13 }, (_, i) => i + 1));
const DUPLICATE_TARGET_RULE =
  "duplicate_of needs an existing acyclic retained target.";
const WHOLE_FILE_PATHS = new Set([
  ".trunk/hooks/pre-push",
  "scripts/agent-quality-gate.sh",
  "scripts/agent-quality-gate.test.sh",
  "scripts/check-agent-quality-gate-package-scripts.mjs",
]);
const REFERENCE_PATTERN =
  /agent[:-](?:quality-gate|prewarm)|gate:routing-table:test|quality[- ]gate|scripts\/gate\/|run\.lock|skip-if-fresh|\bGATE_[A-Z0-9_]+/i;
function fail(message) {
  throw new Error(message);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function requireList(value, label, isValid) {
  const valid =
    Array.isArray(value) && value.length > 0 && value.every(isValid);
  if (!valid) fail(`${label} must be a non-empty valid array.`);
}
function requireRiskList(value, label, allowed) {
  requireList(value, label, (risk) => Number.isInteger(risk) && risk > 0);
  if (
    new Set(value).size !== value.length ||
    value.some((risk) => allowed && !allowed.has(risk))
  )
    fail(`${label} contains a duplicate or unknown risk class.`);
}
function validateDuplicateTargets(safeguards) {
  const byId = new Map(safeguards.map((record) => [record.id, record]));
  for (const record of safeguards) {
    if (record.disposition !== "duplicate") continue;
    const seen = new Set([record.id]);
    let target = record.duplicate_of;
    for (;;) {
      const targetRecord = byId.get(target);
      if (!targetRecord || seen.has(target))
        fail(`${record.id} ${DUPLICATE_TARGET_RULE}`);
      if (targetRecord.disposition !== "duplicate") {
        if (!RETAINED.has(targetRecord.disposition))
          fail(`${record.id} ${DUPLICATE_TARGET_RULE}`);
        break;
      }
      seen.add(target);
      target = targetRecord.duplicate_of;
    }
  }
}
export function parseInventory(raw) {
  return raw.split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      fail(`Inventory line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}
export function validateInventory(records) {
  const metadata = records.filter((record) => record.kind === "metadata");
  if (metadata.length !== 1 || records[0]?.kind !== "metadata")
    fail("Inventory must start with exactly one metadata record.");
  if (metadata[0].schema_version !== 1) fail("Unsupported inventory schema.");
  for (const field of ["reviewed_at", "owner"])
    if (!isNonEmptyString(metadata[0][field])) fail(`Metadata needs ${field}.`);
  if (
    typeof metadata[0].baseline_source_sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(metadata[0].baseline_source_sha)
  )
    fail("Metadata needs a full baseline_source_sha.");
  const risks = metadata[0].risk_classes;
  requireRiskList(risks, "Metadata risk_classes", REQUIRED_RISKS);
  if (risks.length !== REQUIRED_RISKS.size)
    fail("Metadata risk_classes must define exactly classes 1 through 13.");
  const allowedRisks = REQUIRED_RISKS;
  const safeguards = records.filter((record) => record.kind === "safeguard");
  if (safeguards.length === 0 || records.length !== safeguards.length + 1)
    fail("Inventory may contain only metadata and safeguard records.");
  const ids = new Set();
  for (const record of safeguards) {
    if (!isNonEmptyString(record.id)) fail("Safeguard needs id.");
    for (const field of ["category", "name", "owner"])
      if (!isNonEmptyString(record[field]))
        fail(`${record.id} needs ${field}.`);
    requireList(record.sources, `${record.id} sources`, isNonEmptyString);
    requireRiskList(
      record.risk_classes,
      `${record.id} risk_classes`,
      allowedRisks,
    );
    if (ids.has(record.id)) fail(`Duplicate safeguard id: ${record.id}`);
    ids.add(record.id);
    if (
      typeof record.disposition !== "string" ||
      !Object.hasOwn(DISPOSITION_FIELDS, record.disposition)
    )
      fail(`${record.id} has invalid disposition.`);
    const evidenceField = DISPOSITION_FIELDS[record.disposition];
    if (
      !Object.hasOwn(record, evidenceField) ||
      !isNonEmptyString(record[evidenceField])
    )
      fail(`${record.id} needs ${evidenceField}.`);
    for (const field of DISPOSITION_EVIDENCE_FIELDS)
      if (field !== evidenceField && Object.hasOwn(record, field))
        fail(`${record.id} has incompatible disposition evidence.`);
  }
  validateDuplicateTargets(safeguards);
  return { metadata: metadata[0], safeguard_count: safeguards.length };
}
function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
function countLines(text) {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}
function surfaceFor(path, wholeFile) {
  if (path.startsWith(".trunk/hooks/")) return "hook";
  if (wholeFile)
    return /\.test\.[^/]+$/u.test(path) ? "test" : "implementation";
  if (path === "package.json") return "alias";
  if (/\.ya?ml$/u.test(path)) return "yaml-or-inline-shell";
  if (/\.md$/u.test(path) || path.endsWith("AGENTS.md")) return "instruction";
  if (/\.sh$/u.test(path)) return "shell-reference";
  return "configuration-reference";
}
function countReferenceLines(path, content) {
  const lines = content.split("\n");
  const selected = new Set();
  lines.forEach((line, index) => {
    if (REFERENCE_PATTERN.test(line)) selected.add(index);
  });
  if (path === ".trunk/trunk.yaml") {
    const start = lines.findIndex((line) =>
      line.includes("- trunk-check-pre-push"),
    );
    const end = lines.findLastIndex(
      (line) => line.trim() === "- agent-quality-gate-pre-push",
    );
    if (start < 0 || end < start)
      fail("Cannot locate the Trunk quality-gate action block.");
    for (let index = start; index <= end; index += 1) selected.add(index);
  }
  if (path === "turbo.json") {
    lines.forEach((line, index) => {
      if (!REFERENCE_PATTERN.test(line)) return;
      let start = index;
      while (start >= 0 && !/^\s*"inputs": \[$/u.test(lines[start])) start -= 1;
      if (start < 0) fail("Cannot locate a Turbo gate input filter.");
      let depth = 0;
      for (let cursor = start; cursor < lines.length; cursor += 1) {
        depth += (lines[cursor].match(/\[/gu) ?? []).length;
        depth -= (lines[cursor].match(/\]/gu) ?? []).length;
        selected.add(cursor);
        if (depth === 0) break;
      }
    });
  }
  return selected.size;
}
export function buildManifest({ repoRoot = DEFAULT_ROOT, source }) {
  const sourceSha = git(repoRoot, ["rev-parse", `${source}^{commit}`]).trim();
  const paths = git(repoRoot, ["ls-tree", "-r", "-z", sourceSha])
    .split("\0")
    .map((entry) => entry.match(/^\d+ blob [0-9a-f]+\t(.+)$/u)?.[1])
    .filter(Boolean)
    .sort();
  for (const path of WHOLE_FILE_PATHS)
    if (!paths.includes(path)) fail(`Missing manifest path: ${path}`);
  const entries = [];
  for (const path of paths) {
    const wholeFile =
      WHOLE_FILE_PATHS.has(path) || path.startsWith("scripts/gate/");
    const content = git(repoRoot, ["show", `${sourceSha}:${path}`]);
    if (content.includes("\0")) continue;
    const lines = wholeFile
      ? countLines(content)
      : countReferenceLines(path, content);
    if (lines === 0) continue;
    entries.push({
      path,
      surface: surfaceFor(path, wholeFile),
      count_mode: wholeFile ? "whole-file" : "matching-lines",
      lines,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  const totals = entries.reduce(
    (result, entry) => {
      result.files += 1;
      result.counted_lines += entry.lines;
      result.by_surface[entry.surface] =
        (result.by_surface[entry.surface] ?? 0) + entry.lines;
      return result;
    },
    { files: 0, counted_lines: 0, by_surface: {} },
  );
  totals.by_surface = Object.fromEntries(
    Object.entries(totals.by_surface).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return {
    schema_version: 1,
    source_sha: sourceSha,
    definitions: {
      whole_file:
        "Physical lines in the gate entry points, every scripts/gate/** file, the package-script pin checker, and the full pre-push hook. The gate-rooted set includes retained shared-consumer code.",
      matching_lines:
        "Unique fixed-pattern lines in other tracked files, full Turbo input filters that pin gate sources, and the full Trunk gate action block.",
    },
    entries,
    totals,
  };
}
export function checkManifest(actual, expected, baselineSourceSha) {
  if (
    expected.source_sha !== baselineSourceSha ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  )
    fail("Control-plane manifest is stale; run verification:manifest:write.");
}
export function renderManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
function readValidatedInventory(inventoryPath) {
  return validateInventory(parseInventory(readFileSync(inventoryPath, "utf8")));
}
export function runCli(
  args,
  {
    repoRoot = DEFAULT_ROOT,
    inventoryPath = DEFAULT_INVENTORY,
    manifestPath = DEFAULT_MANIFEST,
    stdout = process.stdout,
  } = {},
) {
  const command = args[0];
  const inventory = readValidatedInventory(inventoryPath);
  if (command === "--check-inventory") {
    stdout.write(
      `OK: ${inventory.safeguard_count} structurally valid safeguard records.\n`,
    );
    return;
  }
  if (command === "--write-manifest") {
    const source = args[1] ?? inventory.metadata.baseline_source_sha;
    const manifest = buildManifest({ repoRoot, source });
    writeFileSync(manifestPath, renderManifest(manifest));
    stdout.write(`Wrote manifest for ${manifest.source_sha}.\n`);
    return;
  }
  if (command === "--check-manifest") {
    const expected = JSON.parse(readFileSync(manifestPath, "utf8"));
    const actual = buildManifest({ repoRoot, source: expected.source_sha });
    checkManifest(actual, expected, inventory.metadata.baseline_source_sha);
    stdout.write(`OK: manifest matches ${expected.source_sha}.\n`);
    return;
  }
  fail("Use --check-inventory, --write-manifest [ref], or --check-manifest.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`verification evidence: ${error.message}`);
    process.exitCode = 1;
  }
}
