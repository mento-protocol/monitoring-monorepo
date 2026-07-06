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
 * base ref and, when none of them are accompanied by a new ADR, prints a
 * reminder. It is deliberately self-suppressing: it stays silent when there is
 * no trigger, or when the same diff already adds an ADR — so it is safe to run
 * on every push without becoming noise the reader learns to ignore.
 *
 * Advisory by default (exit 0). Pass `--strict` to exit non-zero on an
 * un-accompanied trigger so a CI job can hard-gate if a team wants that.
 *
 * Usage: node scripts/check-adr-reminder.mjs [--base <ref>] [--strict]
 */
import { execFileSync } from "node:child_process";
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
 * True when the same diff already adds a numbered ADR (README changes do not
 * count) — the decision is being recorded, so stay quiet.
 * @param {string[]} addedFiles
 * @returns {boolean}
 */
export function adrBeingWritten(addedFiles = []) {
  return addedFiles.some((file) => /^docs\/adr\/\d{4}-.+\.md$/.test(file));
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

function baseExists(base) {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** Collect the diff facts the pure detector needs. */
export function collectGitState(base) {
  const added = new Set([
    ...lines(git(["diff", "--diff-filter=A", "--name-only", base, "--"])),
    ...lines(git(["ls-files", "--others", "--exclude-standard"])),
  ]);
  const addedFiles = [...added];

  // A new stack entry shows up as an added object with a "path" key.
  const stacksDiff = git(["diff", base, "--", "terraform.stacks.json"]);
  const stacksIsNew = addedFiles.includes("terraform.stacks.json");
  const stacksAddsNewStack =
    stacksIsNew ||
    lines(stacksDiff).some((line) => /^\+.*"path"\s*:/.test(line));

  // A new workspace package shows up as an added `- <glob>` list item.
  const workspaceDiff = git(["diff", base, "--", "pnpm-workspace.yaml"]);
  const workspaceAddsPackage = lines(workspaceDiff).some((line) =>
    /^\+\s*-\s+\S/.test(line),
  );

  return { addedFiles, stacksAddsNewStack, workspaceAddsPackage };
}

function main(argv) {
  let base = process.env.AGENT_QUALITY_BASE || "origin/main";
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
    else if (argv[i] === "--strict") strict = true;
  }

  if (!baseExists(base)) {
    // Nothing to diff against (e.g. base not fetched) — do not block, do not nag.
    console.log(
      `[adr-reminder] base ref '${base}' not found; skipping (advisory).`,
    );
    return 0;
  }

  const state = collectGitState(base);
  if (adrBeingWritten(state.addedFiles)) {
    return 0; // A decision is being recorded — quiet.
  }

  const triggers = detectAdrTriggers(state);
  if (triggers.length === 0) {
    return 0; // No architectural trigger — quiet.
  }

  console.log(
    "\n[adr-reminder] This change touches an architecturally significant surface but adds no ADR:",
  );
  for (const t of triggers) {
    console.log(`  • ${t.surface} — ${t.why}`);
  }
  console.log(
    "Does it encode an architectural decision (constrains future work · had a real\n" +
      "alternative · the why is not obvious from the code)? If yes, record it under\n" +
      'docs/adr/ in this PR. If not, note why on the PR\'s "Architecture decision?" line.\n' +
      "Procedure: docs/pr-checklists/architecture-decisions.md\n",
  );

  return strict ? 1 : 0;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
