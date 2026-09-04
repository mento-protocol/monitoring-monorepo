#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
const DUPLICATE_TARGET_RULE = "duplicate_of needs an acyclic retained target.";
const GIT_OPTIONS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
const OPTIONAL_WHOLE_FILE_PATHS = new Set([".trunk/hooks/pre-push"]);
const TRUNK_PRE_PUSH_MARKER =
  /trunk-check-pre-push|agent-quality-gate-pre-push|git_hooks:\s*\[pre-push\]|agent-quality-gate\.sh.*(?:--skip-if-fresh|--pre-push)/u;
const REQUIRED_WHOLE_FILE_PATHS = new Set(
  "docs/adr/0007-agent-quality-gate-and-merge-oracle.md docs/adr/0069-gate-routing-table-as-data.md docs/adr/0076-fair-quality-gate-coordinator.md docs/notes/agent-quality-gate-mechanics.md scripts/agent-quality-gate.sh scripts/agent-quality-gate.test.sh scripts/check-agent-quality-gate-package-scripts.mjs".split(
    " ",
  ),
);
const REQUIRED_REPLACEMENT_WHOLE_FILE_PATHS = new Set(
  ".agents/roles/standards-enforcer.md .agents/roles/verifier.md .agents/skills/ship/SKILL.md .claude/skills/ship/SKILL.md .trunk/hooks/pre-commit .trunk/trunk.yaml docs/notes/pr-operating-card.md scripts/bootstrap/agent-setup-contract.test.sh scripts/docs/check-verification-redesign-evidence-source-patch.test.mjs scripts/docs/check-verification-redesign-evidence.mjs scripts/docs/check-verification-redesign-evidence.test.mjs scripts/pr/closeout-review-exec.mjs scripts/pr/closeout-review-git.mjs scripts/pr/closeout-review.mjs scripts/pr/closeout-review.test.mjs scripts/repo-health/check-guardrail-prose.mjs scripts/repo-health/check-guardrail-prose.test.mjs scripts/repo-health/guardrail-prose.json".split(
    " ",
  ),
);
const SCOPED_REFERENCE_PATTERN =
  /^(?:(?:\.agents\/skills\/backlog-sweep\/SKILL\.md|\.claude\/skills\/backlog-sweep\/SKILL\.md|docs\/adr\/0077-operator-triggered-backlog-sweep\.md|docs\/notes\/backlog-sweep\.md):.*run\.lock|docs\/adr\/(?:0064-scripts-module-directories|0073-guardrail-prose-pinned-in-ci)\.md:.*\b(?:lockfile-scope|arms-packages|pins\.test|routing-table\.test|engine\.test|arms-scripts|arms-agent-modules)\.mjs\b|scripts\/sentry\/ci-wiring\/check-sentry-suites-in-ci-gate-probe\.mjs:.*\bfacts\.mjs\b|(?:\.agents\/roles\/verifier\.md|(?:\.agents|\.claude)\/skills\/backlog-sweep\/SKILL\.md|docs\/notes\/(?:backlog-sweep|pr-ready-state)\.md|docs\/pr-checklists\/review-prompt-exclusions\.md):.*--run(?!-)|docs\/notes\/pr-operating-card\.md:.*--(?:run|base)(?!-)|scripts\/pr\/check-adr-reminder\.mjs:.*(?:\bgate.*--(?:head|changed-paths-file)(?!-)|--(?:head|changed-paths-file)(?!-).*\bgate)|scripts\/agent-autoreview\.sh:.*\bgate_stat\b|(?!(?:scripts\/sentry\/ci-wiring\/check-sentry-suites-in-ci-gate-job\.test\.mjs|scripts\/sentry\/gate\/sentry-suite-gate-integrity\.mjs):)[^:]+:.*\bGATE_[A-Z0-9_]+)/u;
const EXCLUDED_REFERENCE_PATH =
  /^(?:ui-dashboard\/scripts\/(?:arkham-smoke-test\.mjs|intel-marathon\/tier1-bulk-enrich\.mjs)|indexer-envio\/\.cursor\/rules\/subgraph-migration\.mdc)$/u;
const REFERENCE_PATTERN =
  /agent[:-](?:quality-gate|prewarm)|\bagent\.qualityGate(?:\.|\b)|gate:routing-table:test|scripts\/gate\/|(?:^|["'`(])(?:\.\.?\/)*gate\/|\$[^"'\s]*\\?\/gate(?:\\?\/|["':])|["']gate["']\s*,\s*["'][^"']+\.(?:c|mjs|sh)["']|\.terraform-agent-gate(?:\/|\b)|skip-if-fresh|--(?:allow-package-script-changes|full-local-tests|lock-wait|no-lock|command-timeout|command-not-started)(?!-)|\b(?:AGENT_(?:QUALITY|GATE|PREWARM)|AGENTQG|QUALITY_GATE)_[A-Z0-9_]+|\bAGENT_TURBO_SHARED_CACHE\b|\bagentqg[:-]|inheritGateMarkerStdio|mapped-command-process-identity\.mjs|\bdarwin-process-(?:identity|lineage)[a-z0-9._-]*|\b(?:portable-marker-v1|request-marker-empty-v1|darwin-coherent-lineage-v2|darwin-unique-lineage-v1|coordinator-owner-v1)\b|\btrunk-check-once(?:\.test)?\.sh/i;
const REPLACEMENT_REFERENCE_PATTERN =
  /agent:closeout-review|(?:direct )?(?:author|package) checks?|author[- ](?:check(?: table| rows?| contract| mapping| triggers?)|checkpoint)|PR operating card|optional legacy (?:gate|diagnostic)|Required CI (?:runs|owns|remains)|pre-(?:commit hook|push verification)|code-generation variant|non-mainnet variants first|staged formatting on pre-commit/i;
const REPLACEMENT_ALIAS_PATTERN =
  /^\s*"(?:agent:closeout-review(?::test)?|verification:[^"]+)"\s*:/u;
const matchesReference = (p, line) =>
  REFERENCE_PATTERN.test(line) ||
  SCOPED_REFERENCE_PATTERN.test(`${p}:${line}`) ||
  (!EXCLUDED_REFERENCE_PATH.test(p) && /\bquality[- ]gates?\b/i.test(line));
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
      REQUIRED_RISKS,
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
const git = (root, args) =>
  execFileSync("git", ["-C", root, ...args], GIT_OPTIONS);
const nlines = (s) => (s ? s.split("\n").length - +s.endsWith("\n") : 0);
function surfaceFor(path, wholeFile) {
  if (path.startsWith(".trunk/hooks/")) return "hook";
  if (/\.md$/u.test(path) || path.endsWith("AGENTS.md")) return "instruction";
  if (/\.ya?ml$/u.test(path)) return "yaml-or-inline-shell";
  if (path === "scripts/repo-health/guardrail-prose.json")
    return "configuration-reference";
  if (wholeFile)
    return /\.test\.[^/]+$/u.test(path) ? "test" : "implementation";
  if (path === "package.json") return "alias";
  if (/\.sh$/u.test(path)) return "shell-reference";
  return "configuration-reference";
}
function countReferenceLines(path, content, replacementActive) {
  const lines = content.split("\n");
  const selected = new Set();
  lines.forEach((line, index) => {
    if (
      matchesReference(path, line) ||
      (replacementActive &&
        (REPLACEMENT_REFERENCE_PATTERN.test(line) ||
          (path === "package.json" && REPLACEMENT_ALIAS_PATTERN.test(line))))
    )
      selected.add(index);
  });
  if (path === ".trunk/trunk.yaml") {
    const legacyMarkerIndexes = lines.flatMap((line, index) =>
      TRUNK_PRE_PUSH_MARKER.test(line) ? [index] : [],
    );
    if (legacyMarkerIndexes.length === 0) return selected.size;

    const start = lines.findIndex((line) =>
      line.includes("- trunk-check-pre-push"),
    );
    const definition = lines.findIndex(
      (line) => line.trim() === "- id: agent-quality-gate-pre-push",
    );
    const run = lines.findIndex((line) =>
      /run: .*agent-quality-gate\.sh.*(?:--skip-if-fresh|--pre-push)/u.test(
        line,
      ),
    );
    const trigger = lines.findIndex((line) =>
      /git_hooks:\s*\[pre-push\]/u.test(line),
    );
    const end = lines.findLastIndex(
      (line) => line.trim() === "- agent-quality-gate-pre-push",
    );
    if (
      start < 0 ||
      definition <= start ||
      run <= definition ||
      trigger <= run ||
      end <= trigger
    )
      fail(
        "Trunk quality-gate action block is partially removed or malformed.",
      );
    for (let index = start; index <= end; index += 1) selected.add(index);
  }
  if (path === "turbo.json") {
    const source = ts.parseJsonText(path, content);
    if (source.parseDiagnostics.length)
      fail("Cannot parse Turbo input filters.");
    ts.forEachChildRecursively(source, (node) => {
      if (!ts.isPropertyAssignment(node)) return;
      if (node.name.text !== "inputs") return;
      const input = node.initializer;
      if (!ts.isArrayLiteralExpression(input)) return;
      if (!REFERENCE_PATTERN.test(input.getText(source))) return;
      const line = (position) =>
        source.getLineAndCharacterOfPosition(position).line;
      for (let index = line(input.pos); index <= line(input.end); index += 1)
        selected.add(index);
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
  for (const path of REQUIRED_WHOLE_FILE_PATHS)
    if (!paths.includes(path)) fail(`Missing manifest path: ${path}`);
  const hookPresent = paths.includes(".trunk/hooks/pre-push");
  const trunkConfig = paths.includes(".trunk/trunk.yaml")
    ? git(repoRoot, ["show", `${sourceSha}:.trunk/trunk.yaml`])
    : fail("Missing manifest path: .trunk/trunk.yaml");
  const trunkActionPresent = TRUNK_PRE_PUSH_MARKER.test(trunkConfig);
  if (hookPresent !== trunkActionPresent)
    fail(
      "The pre-push hook and Trunk quality-gate action must be retained or removed together.",
    );
  const replacementActive = !hookPresent && !trunkActionPresent;
  for (const path of replacementActive
    ? REQUIRED_REPLACEMENT_WHOLE_FILE_PATHS
    : [])
    if (!paths.includes(path))
      fail(`Missing replacement manifest path: ${path}`);
  const entries = [];
  for (const path of paths) {
    const wholeFile =
      OPTIONAL_WHOLE_FILE_PATHS.has(path) ||
      REQUIRED_WHOLE_FILE_PATHS.has(path) ||
      path.startsWith("scripts/gate/") ||
      (replacementActive && REQUIRED_REPLACEMENT_WHOLE_FILE_PATHS.has(path));
    const content = git(repoRoot, ["show", `${sourceSha}:${path}`]);
    if (content.includes("\0")) continue;
    const lines = wholeFile
      ? nlines(content)
      : countReferenceLines(path, content, replacementActive);
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
    definitions: replacementActive
      ? {
          whole_file:
            "Physical lines in the gate entry points, dedicated canonical gate documents, every scripts/gate/** file, and the required author, closeout-review, guardrail, setup-contract, pre-commit, and Trunk surfaces.",
          matching_lines:
            "Unique fixed-pattern legacy or replacement lines in other tracked files, verification aliases, full Turbo input filters that pin gate sources, and the full legacy Trunk gate action block.",
        }
      : {
          whole_file:
            "Physical lines in the gate entry points, dedicated canonical gate documents, every scripts/gate/** file, the package-script pin checker, and the full pre-push hook. The gate-rooted set includes retained shared-consumer code.",
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
  const inventory = validateInventory(
    parseInventory(readFileSync(inventoryPath, "utf8")),
  );
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
