#!/usr/bin/env node
/**
 * Advisory ADR reminder gate.
 *
 * Architectural decisions in this repo are recorded as ADRs under `docs/adr/`
 * (see ADR 0005 / ADR 0033 and `docs/pr-checklists/architecture-decisions.md`).
 * The failure mode this guards against is a PR that makes a genuine
 * architectural decision — a new package/service, a new Terraform stack, a new
 * CI/deploy workflow — and forgets to record why.
 *
 * It detects a small set of HIGH-SIGNAL architectural triggers in the diff vs a
 * base ref. Detection is intentionally precise (a real new package / stack, not
 * a reformat or an unrelated list edit) because the tool's only value is
 * credibility: a nag that cries wolf gets ignored. It stays silent when there
 * is no trigger; when a trigger is present it prints — either a full reminder
 * (no ADR in the change) or a lighter "confirm each surface is covered" note
 * (an ADR is present, so the author is clearly ADR-aware).
 *
 * Advisory by default (exit 0). Pass `--strict` to exit non-zero on a trigger
 * that has no accompanying ADR so a CI job can hard-gate if a team wants that.
 *
 * Usage: node scripts/check-adr-reminder.mjs [--base <ref>] [--head <ref>]
 *          [--strict] [--include-untracked]
 *
 * The agent quality gate passes its own `--head` and `--include-untracked` so
 * the reminder sees exactly what the gate sees (committed + staged + untracked
 * high-signal files). Standalone runs default to committed/staged only, so an
 * unrelated untracked scratch file never nags.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Pure trigger detection — kept free of git/IO so it is directly testable.
 * @param {{addedFiles: string[], stacksAddsNewStack: boolean, workspaceAddsPackage: boolean}} input
 * @returns {{surface: string, why: string}[]}
 */
export function detectAdrTriggers({
  addedFiles = [],
  stacksAddsNewStack = false,
  workspaceAddsPackage = false,
}) {
  const triggers = [];
  for (const file of addedFiles) {
    const scoped = /^([^/]+)\/AGENTS\.md$/.exec(file);
    if (scoped) {
      triggers.push({
        surface: file,
        why: `new package/service "${scoped[1]}/" (new scoped AGENTS.md)`,
      });
    }
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(file)) {
      triggers.push({
        surface: file,
        why: "new GitHub Actions workflow (new CI/deploy path or required check)",
      });
    }
  }
  if (stacksAddsNewStack) {
    triggers.push({
      surface: "terraform.stacks.json",
      why: "a new Terraform stack was registered",
    });
  }
  if (workspaceAddsPackage) {
    triggers.push({
      surface: "pnpm-workspace.yaml",
      why: "a workspace package was added",
    });
  }
  return triggers;
}

/**
 * True when the change adds a numbered ADR (README changes do not count).
 * @param {string[]} addedFiles
 * @returns {boolean}
 */
export function adrBeingWritten(addedFiles = []) {
  return addedFiles.some((file) => /^docs\/adr\/\d{4}-[^/]+\.md$/.test(file));
}

/**
 * Stack identifiers (`stacks[].id`) declared in a terraform.stacks.json blob.
 * Returns [] for empty/unparsable input so a missing base file degrades to
 * "everything in head is new" without throwing.
 * @param {string} jsonText
 * @returns {string[]}
 */
export function extractStackIds(jsonText) {
  if (!jsonText.trim()) return [];
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed?.stacks)) return [];
    return parsed.stacks
      .map((stack) => stack?.id)
      .filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

/**
 * Package globs under the top-level `packages:` key of a pnpm-workspace.yaml
 * blob. Only the `packages:` list — NOT `minimumReleaseAgeExclude`,
 * `ignoredBuiltDependencies`, or the other `- item` sections that share YAML
 * list syntax.
 * @param {string} yamlText
 * @returns {string[]}
 */
export function extractPackagesList(yamlText) {
  const out = [];
  let inPackages = false;
  for (const raw of yamlText.split("\n")) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (raw.trim() === "") continue; // blank line stays inside the block
    if (/^\S/.test(raw)) break; // next top-level key ends the block
    const item = /^\s+-\s+(.+?)\s*$/.exec(raw);
    if (item) out.push(item[1].replace(/^["']|["']$/g, ""));
  }
  return out;
}

/**
 * Whether `headList` contains an entry absent from `baseList`.
 * @param {string[]} baseList
 * @param {string[]} headList
 * @returns {boolean}
 */
export function hasNewEntry(baseList, headList) {
  const base = new Set(baseList);
  return headList.some((entry) => !base.has(entry));
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return "";
  }
}

function lines(text) {
  return text.split("\n").filter(Boolean);
}

function readHead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function baseExists(base) {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function headContent(head, path) {
  return head ? git(["show", `${head}:${path}`]) : readHead(path);
}

/**
 * Collect the diff facts the pure detector needs.
 *
 * Added files come from the base→head diff (committed + staged additions). When
 * `includeUntracked` is set — which the quality gate passes so this checker sees
 * exactly the gate's changed-path set — untracked new files are added too, so a
 * not-yet-committed new package/workflow is not invisible during a local gate
 * run. Standalone runs leave it off, so an unrelated untracked scratch file
 * never nags.
 */
export function collectGitState(
  base,
  { head = "", includeUntracked = false } = {},
) {
  const diffArgs = head
    ? ["diff", "--diff-filter=A", "--name-only", base, head, "--"]
    : ["diff", "--diff-filter=A", "--name-only", base, "--"];
  const added = new Set(lines(git(diffArgs)));
  if (includeUntracked) {
    for (const file of lines(
      git(["ls-files", "--others", "--exclude-standard"]),
    )) {
      added.add(file);
    }
  }
  const addedFiles = [...added];

  // Compare declared stacks/packages between base and head so only a genuinely
  // new registration triggers — not a path edit, a reformat, or an unrelated
  // list section that happens to share YAML `- item` syntax.
  const stacksAddsNewStack = hasNewEntry(
    extractStackIds(git(["show", `${base}:terraform.stacks.json`])),
    extractStackIds(headContent(head, "terraform.stacks.json")),
  );
  const workspaceAddsPackage = hasNewEntry(
    extractPackagesList(git(["show", `${base}:pnpm-workspace.yaml`])),
    extractPackagesList(headContent(head, "pnpm-workspace.yaml")),
  );

  return { addedFiles, stacksAddsNewStack, workspaceAddsPackage };
}

function printSurfaces(triggers) {
  for (const t of triggers) console.log(`  • ${t.surface} — ${t.why}`);
}

function main(argv) {
  let base = process.env.AGENT_QUALITY_BASE || "origin/main";
  let head = "";
  let strict = false;
  let includeUntracked = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
    else if (argv[i] === "--head") head = argv[++i] ?? "";
    else if (argv[i] === "--strict") strict = true;
    else if (argv[i] === "--include-untracked") includeUntracked = true;
  }
  // The gate's --head defaults to "HEAD", meaning "the current checkout". Treat
  // that (and empty) as the WORKING TREE so staged/uncommitted edits to
  // pnpm-workspace.yaml / terraform.stacks.json and not-yet-committed new files
  // are seen. Only an explicit non-HEAD ref reads that ref's committed content.
  if (head === "HEAD") head = "";

  if (!baseExists(base)) {
    // Nothing to diff against (e.g. base not fetched) — do not block, do not nag.
    console.log(
      `[adr-reminder] base ref '${base}' not found; skipping (advisory).`,
    );
    return 0;
  }

  const state = collectGitState(base, { head, includeUntracked });
  const triggers = detectAdrTriggers(state);
  if (triggers.length === 0) {
    return 0; // No architectural trigger — quiet.
  }

  if (adrBeingWritten(state.addedFiles)) {
    // An ADR is present, so the author is ADR-aware. Still list the surfaces —
    // a second, uncovered decision must not be silently skipped — but never fail.
    console.log(
      "\n[adr-reminder] Architectural surface(s) changed and an ADR is present in this change — confirm each is covered by an ADR:",
    );
    printSurfaces(triggers);
    console.log(
      "If a surface above is a separate new decision without its own ADR, add one.\n" +
        "Procedure: docs/pr-checklists/architecture-decisions.md\n",
    );
    return 0;
  }

  console.log(
    "\n[adr-reminder] This change touches an architecturally significant surface but adds no ADR:",
  );
  printSurfaces(triggers);
  console.log(
    "Does it encode an architectural decision (constrains future work · had a real\n" +
      "alternative · the why is not obvious from the code)? If yes, record it under\n" +
      'docs/adr/ in this change. If not, note why on the PR\'s "Architecture decision?" line.\n' +
      "Procedure: docs/pr-checklists/architecture-decisions.md\n",
  );

  return strict ? 1 : 0;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
