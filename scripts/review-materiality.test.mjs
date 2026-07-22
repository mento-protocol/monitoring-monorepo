#!/usr/bin/env node
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  analyzeMateriality,
  parseArgs,
  renderHuman,
} from "./review-materiality.mjs";
import {
  createContextSnapshotReaders,
  resolveCanonicalContextPaths,
} from "./review-materiality-context.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(haystack, needle) {
  assert(
    haystack.includes(needle),
    `expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`,
  );
}

function stats(entries) {
  return new Map(Object.entries(entries));
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function contextNote(canonical) {
  return `---
title: Fixture runbook
status: active
owner: eng
canonical: ${canonical}
last_verified: ${new Date().toISOString().slice(0, 10)}
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Fixture runbook
`;
}

function materialityCliFixture(noteContent) {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-context-test-"));
  const pathsFile = join(dir, "paths.txt");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(dir, "docs", "notes"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(dir, "docs", "notes", "runbook.md"), noteContent);
  writeFileSync(pathsFile, ".github/workflows/ci.yml\ndocs/notes/runbook.md\n");
  return { dir, pathsFile };
}

function runMaterialityCli(cwd, pathsFile, json = false) {
  return spawnSync(
    process.execPath,
    [
      new URL("./review-materiality.mjs", import.meta.url).pathname,
      "--changed-paths-file",
      pathsFile,
      ...(json ? ["--json"] : []),
    ],
    { cwd, encoding: "utf8" },
  );
}

console.log("\nreview-materiality.mjs tests\n");

test("context helper separates base authority from valid head presence", () => {
  const note = "docs/notes/runbook.md";
  const { headCanonicalContextPaths, materialityCanonicalContextPaths } =
    resolveCanonicalContextPaths({
      paths: ["AGENTS.md", note],
      readBaseContextFile: (filePath) => {
        if (filePath === note) return contextNote("true");
        throw new Error("absent at base");
      },
      readHeadContextFile: (filePath) => {
        if (filePath === note) return contextNote("false");
        throw new Error("unreadable at head");
      },
      isHeadContextFile: (filePath) => filePath === note,
    });

  assert(materialityCanonicalContextPaths.has("AGENTS.md"));
  assert(materialityCanonicalContextPaths.has(note));
  assertEqual(headCanonicalContextPaths.has("AGENTS.md"), false);
  assertEqual(headCanonicalContextPaths.has(note), false);
});

test("context snapshot readers bind refs and reject worktree symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-reader-test-"));
  const originalCwd = process.cwd();
  const filePath = "context.md";

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    writeFileSync(join(dir, filePath), "base\n");
    git(dir, ["add", filePath]);
    git(dir, ["commit", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]).trim();

    writeFileSync(join(dir, filePath), "committed head\n");
    git(dir, ["add", filePath]);
    git(dir, ["commit", "-m", "head"]);
    const committedHead = git(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, filePath), "worktree head\n");
    process.chdir(dir);

    const worktreeReaders = createContextSnapshotReaders({
      base,
      head: "HEAD",
    });
    assertEqual(worktreeReaders.readBaseContextFile(filePath), "base\n");
    assertEqual(
      worktreeReaders.readHeadContextFile(filePath),
      "worktree head\n",
    );
    assertEqual(worktreeReaders.isHeadContextFile(filePath), true);

    rmSync(join(dir, filePath));
    writeFileSync(join(dir, "target.md"), "symlink target\n");
    symlinkSync("target.md", join(dir, filePath));
    assertEqual(worktreeReaders.isHeadContextFile(filePath), false);
    let readError = null;
    try {
      worktreeReaders.readHeadContextFile(filePath);
    } catch (error) {
      readError = error;
    }
    assertIncludes(String(readError), "not a regular worktree file");

    const committedReaders = createContextSnapshotReaders({
      base,
      head: committedHead,
    });
    assertEqual(
      committedReaders.readHeadContextFile(filePath),
      "committed head\n",
    );
    assertEqual(committedReaders.isHeadContextFile(filePath), true);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifies non-canonical plan-only edits as trivial", () => {
  const report = analyzeMateriality({
    paths: ["docs/PLAN-ai-review-process.md"],
    numstat: stats({
      "docs/PLAN-ai-review-process.md": { additions: 20, deletions: 0 },
    }),
  });

  assertEqual(report.tier, "trivial");
  assertEqual(report.contextUpdateRequired, false);
  assertEqual(report.contextUpdateMissing, false);
});

test("classifies root script changes as full and requiring context", () => {
  const report = analyzeMateriality({
    paths: ["package.json", "scripts/review-materiality.mjs"],
    scriptChanges: [
      {
        name: "agent:review-materiality",
        before: null,
        after: "node scripts/review-materiality.mjs",
        kind: "added",
      },
    ],
  });

  assertEqual(report.tier, "full");
  assertEqual(report.contextUpdateRequired, true);
  assertEqual(report.contextUpdatesPresent, false);
  assertEqual(report.contextUpdateMissing, true);
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    "agent:review-materiality",
  );
});

test("recognizes context updates when canonical docs are present", () => {
  const report = analyzeMateriality({
    paths: ["package.json", "scripts/review-materiality.mjs", "AGENTS.md"],
    scriptChanges: [
      {
        name: "agent:review-materiality",
        before: null,
        after: "node scripts/review-materiality.mjs",
        kind: "added",
      },
    ],
  });

  assertEqual(report.contextUpdateRequired, true);
  assertEqual(report.contextUpdatesPresent, true);
  assertEqual(report.contextUpdateMissing, false);
});

test("CLI recognizes a workflow plus canonical note in human and JSON output", () => {
  const { dir, pathsFile } = materialityCliFixture(contextNote("true"));

  try {
    const human = runMaterialityCli(dir, pathsFile);
    const json = runMaterialityCli(dir, pathsFile, true);
    assertEqual(human.status, 0);
    assertEqual(json.status, 0);
    assertIncludes(human.stdout, "Context update: required and present");

    const report = JSON.parse(json.stdout);
    assertEqual(report.contextUpdateRequired, true);
    assertEqual(report.contextUpdatesPresent, true);
    assertEqual(report.contextUpdateMissing, false);
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.reason,
      "canonical agent or operator context",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects a workflow plus non-canonical note in human and JSON output", () => {
  const { dir, pathsFile } = materialityCliFixture(contextNote("false"));

  try {
    const human = runMaterialityCli(dir, pathsFile);
    const json = runMaterialityCli(dir, pathsFile, true);
    assertEqual(human.status, 0);
    assertEqual(json.status, 0);
    assertEqual(human.stderr, "");
    assertEqual(json.stderr, "");
    assertIncludes(human.stdout, "Context update: required but not present");

    const report = JSON.parse(json.stdout);
    assertEqual(report.contextUpdateRequired, true);
    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.reason,
      "non-canonical planning or note document",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI never follows untracked symlinked context during normal analysis", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-symlink-test-"));
  const script = new URL("./review-materiality.mjs", import.meta.url).pathname;
  const workflow = join(dir, ".github", "workflows", "ci.yml");
  const note = join(dir, "docs", "notes", "runbook.md");
  const agents = join(dir, "AGENTS.md");
  const fifo = join(dir, "context.fifo");

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, "docs", "notes"), { recursive: true });
    writeFileSync(workflow, "name: CI\n");
    git(dir, ["add", ".github/workflows/ci.yml"]);
    git(dir, ["commit", "-m", "base"]);
    writeFileSync(workflow, "name: Updated CI\n");

    const fifoResult = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assertEqual(fifoResult.status, 0);
    symlinkSync(fifo, note);
    symlinkSync(fifo, agents);

    const result = spawnSync(
      process.execPath,
      [script, "--base", "HEAD", "--head", "HEAD", "--json"],
      { cwd: dir, encoding: "utf8", timeout: 2_000 },
    );
    assert(!result.error, result.error?.message ?? "CLI timed out");
    assertEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assertEqual(report.contextUpdateRequired, true);
    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.reason,
      "canonical agent or operator context",
    );
    assertEqual(
      report.pathSignals.find((item) => item.path === "AGENTS.md")?.reason,
      "canonical agent or operator context",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-regular context paths are rejected before their targets are read", () => {
  let headReads = 0;
  const report = analyzeMateriality({
    paths: [".github/workflows/ci.yml", "AGENTS.md", "docs/notes/runbook.md"],
    readBaseContextFile: () => {
      throw new Error("absent at base");
    },
    readHeadContextFile: () => {
      headReads += 1;
      return contextNote("true");
    },
    isHeadContextFile: () => false,
  });

  assertEqual(headReads, 0);
  assertEqual(report.contextUpdatesPresent, false);
  assertEqual(report.contextUpdateMissing, true);
  assertEqual(report.tier, "full");
  assertEqual(
    report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
      ?.reason,
    "canonical agent or operator context",
  );
});

test("CLI keeps a deleted canonical note full without counting context present", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-delete-test-"));
  const script = new URL("./review-materiality.mjs", import.meta.url).pathname;
  const workflow = join(dir, ".github", "workflows", "ci.yml");
  const note = join(dir, "docs", "notes", "runbook.md");

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, "docs", "notes"), { recursive: true });
    writeFileSync(workflow, "name: CI\n");
    writeFileSync(note, contextNote("true"));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "base"]);

    writeFileSync(workflow, "name: Updated CI\n");
    rmSync(note);
    const result = spawnSync(
      process.execPath,
      [script, "--base", "HEAD", "--head", "HEAD", "--json"],
      { cwd: dir, encoding: "utf8" },
    );

    assertEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assertEqual(report.contextUpdateRequired, true);
    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.tier,
      "full",
    );
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.reason,
      "canonical agent or operator context",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI uses merge-base canonical metadata across divergent histories", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-diverge-test-"));
  const script = new URL("./review-materiality.mjs", import.meta.url).pathname;
  const workflow = join(dir, ".github", "workflows", "ci.yml");
  const note = join(dir, "docs", "notes", "runbook.md");
  const pathsFile = join(dir, "paths.txt");

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, "docs", "notes"), { recursive: true });
    writeFileSync(workflow, "name: CI\n");
    writeFileSync(note, contextNote("true"));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "merge base"]);
    const mergeBase = git(dir, ["rev-parse", "HEAD"]).trim();

    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(workflow, "name: Feature CI\n");
    rmSync(note);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "feature deletes runbook"]);

    git(dir, ["checkout", "-b", "named-base", mergeBase]);
    writeFileSync(note, contextNote("false"));
    git(dir, ["add", "docs/notes/runbook.md"]);
    git(dir, ["commit", "-m", "base demotes runbook"]);
    writeFileSync(
      pathsFile,
      ".github/workflows/ci.yml\ndocs/notes/runbook.md\n",
    );

    for (const extraArgs of [[], ["--changed-paths-file", pathsFile]]) {
      const result = spawnSync(
        process.execPath,
        [
          script,
          "--base",
          "named-base",
          "--head",
          "feature",
          ...extraArgs,
          "--json",
        ],
        { cwd: dir, encoding: "utf8" },
      );

      assertEqual(result.status, 0);
      const report = JSON.parse(result.stdout);
      assertEqual(report.contextUpdatesPresent, false);
      assertEqual(report.contextUpdateMissing, true);
      assertEqual(
        report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
          ?.tier,
        "full",
      );
      assertEqual(
        report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
          ?.reason,
        "canonical agent or operator context",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical base keeps demoted or malformed head notes full", () => {
  for (const headContent of [
    contextNote("false"),
    "---\ncanonical: true\nnot valid metadata\n---\n",
  ]) {
    const report = analyzeMateriality({
      paths: [".github/workflows/ci.yml", "docs/notes/runbook.md"],
      readBaseContextFile: () => contextNote("true"),
      readHeadContextFile: () => headContent,
    });

    assertEqual(report.tier, "full");
    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.tier,
      "full",
    );
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.reason,
      "canonical agent or operator context",
    );
  }
});

test("malformed canonical note metadata fails closed", () => {
  for (const content of [
    "---\ncanonical: true\n# Missing delimiter\n",
    "---\ncanonical: true\nnot valid metadata\n---\n",
    '---\ncanonical: "true\n---\n',
    "---\ncanonical: false\ncanonical: true\n---\n",
  ]) {
    const report = analyzeMateriality({
      paths: [".github/workflows/ci.yml", "docs/notes/runbook.md"],
      readBaseContextFile: () => content,
      readHeadContextFile: () => content,
    });

    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.reason,
      "non-canonical planning or note document",
    );
  }
});

test("incomplete canonical note metadata fails closed", () => {
  for (const key of [
    "title",
    "status",
    "owner",
    "last_verified",
    "doc_type",
    "scope",
    "review_interval_days",
    "garden_lane",
  ]) {
    const content = contextNote("true").replace(
      new RegExp(`^${key}:.*\\n`, "m"),
      "",
    );
    const report = analyzeMateriality({
      paths: [".github/workflows/ci.yml", "docs/notes/runbook.md"],
      readBaseContextFile: () => content,
      readHeadContextFile: () => content,
    });

    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(
      report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
        ?.reason,
      "canonical agent or operator context",
    );
  }
});

test("invalid canonical note classification metadata fails closed", () => {
  for (const content of [
    contextNote("true").replace("status: active", "status: unknown"),
    contextNote("true").replace("doc_type: runbook", "doc_type: unknown"),
    contextNote("true").replace(
      "garden_lane: operator-runbooks",
      "garden_lane: unknown",
    ),
    contextNote("true").replace(
      "review_interval_days: 90",
      "review_interval_days: 0",
    ),
  ]) {
    const report = analyzeMateriality({
      paths: [".github/workflows/ci.yml", "docs/notes/runbook.md"],
      readBaseContextFile: () => content,
      readHeadContextFile: () => content,
    });

    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(report.tier, "full");
  }
});

test("invalid canonical note verification dates fail presence closed", () => {
  for (const lastVerified of ["not-a-date", "2000-01-01", "2999-01-01"]) {
    const content = contextNote("true").replace(
      /^last_verified:.*$/m,
      `last_verified: ${lastVerified}`,
    );
    const report = analyzeMateriality({
      paths: [".github/workflows/ci.yml", "docs/notes/runbook.md"],
      readBaseContextFile: () => content,
      readHeadContextFile: () => content,
    });

    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(report.tier, "full");
  }
});

test("incomplete canonical metadata at base retains full materiality", () => {
  const baseContent = contextNote("true").replace(/^doc_type:.*\n/m, "");
  const report = analyzeMateriality({
    paths: [".github/workflows/ci.yml", "docs/notes/runbook.md"],
    readBaseContextFile: () => baseContent,
    readHeadContextFile: () => {
      throw new Error("deleted at head");
    },
  });

  assertEqual(report.contextUpdatesPresent, false);
  assertEqual(report.contextUpdateMissing, true);
  assertEqual(report.tier, "full");
  assertEqual(
    report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
      ?.reason,
    "canonical agent or operator context",
  );
});

test("head-canonical notes do not require a redundant base read", () => {
  let baseReads = 0;
  const report = analyzeMateriality({
    paths: [".github/workflows/ci.yml", "docs/notes/runbook.md"],
    readBaseContextFile: () => {
      baseReads += 1;
      return contextNote("true");
    },
    readHeadContextFile: () => contextNote("true"),
  });

  assertEqual(baseReads, 0);
  assertEqual(report.contextUpdatesPresent, true);
  assertEqual(report.contextUpdateMissing, false);
});

test("deleted convention-based context stays full without counting present", () => {
  for (const filePath of [
    "AGENTS.md",
    "scripts/AGENTS.md",
    "CLAUDE.md",
    "scripts/CLAUDE.md",
    "README.md",
    "docs/context-standards.md",
    "docs/deployment.md",
    "docs/pr-checklists/example.md",
    ".agents/skills/example/SKILL.md",
    ".agents/roles/example.md",
    ".claude/skills/example/SKILL.md",
    ".codex/hooks.json",
    ".claude/settings.json",
  ]) {
    const report = analyzeMateriality({
      paths: [".github/workflows/ci.yml", filePath],
      readBaseContextFile: () => "base context",
      readHeadContextFile: () => {
        throw new Error("deleted at head");
      },
    });

    assertEqual(report.tier, "full");
    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
  }
});

test("renaming convention-based context out of canonical paths is not present", () => {
  const oldPath = "docs/pr-checklists/old-checklist.md";
  const newPath = "docs/notes/old-checklist.md";
  const report = analyzeMateriality({
    paths: [".github/workflows/ci.yml", oldPath, newPath],
    readBaseContextFile: (filePath) => {
      if (filePath === oldPath) return "base context";
      throw new Error("absent at base");
    },
    readHeadContextFile: (filePath) => {
      if (filePath === newPath) return contextNote("false");
      throw new Error("absent at head");
    },
  });

  assertEqual(report.tier, "full");
  assertEqual(report.contextUpdatesPresent, false);
  assertEqual(report.contextUpdateMissing, true);
});

test("file-list mode keeps deleted convention-based context full", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-file-list-test-"));
  const pathsFile = join(dir, "paths.txt");
  writeFileSync(pathsFile, ".github/workflows/ci.yml\nAGENTS.md\n");

  try {
    const result = runMaterialityCli(dir, pathsFile, true);
    assertEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assertEqual(report.tier, "full");
    assertEqual(report.contextUpdatesPresent, false);
    assertEqual(report.contextUpdateMissing, true);
    assertEqual(
      report.pathSignals.find((item) => item.path === "AGENTS.md")?.reason,
      "canonical agent or operator context",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable canonical note metadata fails closed", () => {
  const report = analyzeMateriality({
    paths: [".github/workflows/ci.yml", "docs/notes/runbook.md"],
    readBaseContextFile: () => {
      throw new Error("permission denied");
    },
    readHeadContextFile: () => {
      throw new Error("permission denied");
    },
  });

  assertEqual(report.contextUpdatesPresent, false);
  assertEqual(report.contextUpdateMissing, true);
  assertEqual(
    report.pathSignals.find((item) => item.path === "docs/notes/runbook.md")
      ?.reason,
    "non-canonical planning or note document",
  );
});

test("recognizes scoped Claude context files as canonical context", () => {
  const report = analyzeMateriality({
    paths: ["scripts/review-materiality.mjs", "scripts/CLAUDE.md"],
  });

  assertEqual(report.contextUpdateRequired, true);
  assertEqual(report.contextUpdatesPresent, true);
  assertEqual(report.contextUpdateMissing, false);
});

test("classifies agent hook and permission configs as context", () => {
  const report = analyzeMateriality({
    paths: [".codex/hooks.json", ".claude/settings.json"],
  });

  assertEqual(report.tier, "full");
  assertEqual(report.contextUpdateRequired, true);
  assertEqual(report.contextUpdatesPresent, true);
  assertEqual(report.contextUpdateMissing, false);
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    ".codex/hooks.json changed",
  );
});

test("does not require context updates for pure script test edits", () => {
  const report = analyzeMateriality({
    paths: ["scripts/review-materiality.test.mjs"],
  });

  assertEqual(report.tier, "full");
  assertEqual(report.contextUpdateRequired, false);
  assertEqual(report.contextUpdateMissing, false);
});

test("recognizes multi-segment environment example files", () => {
  const report = analyzeMateriality({
    paths: ["ui-dashboard/.env.production.local.example"],
  });

  assertEqual(report.contextUpdateRequired, true);
  assertEqual(report.contextUpdateMissing, true);
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    "ui-dashboard/.env.production.local.example changed",
  );
});

test("classifies pnpmfile changes as package-manager risk", () => {
  const report = analyzeMateriality({
    paths: [
      "pnpmfile.cjs",
      ".pnpmfile.cjs",
      "ui-dashboard/.npmrc",
      "alerts/infra/onchain-event-handler/pnpm-lock.yaml",
      "alerts/infra/onchain-event-handler/pnpm-workspace.yaml",
      ".node-version",
    ],
  });

  assertEqual(report.tier, "full");
  assertEqual(report.contextUpdateRequired, true);
  assertEqual(report.contextUpdateMissing, true);
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    "pnpmfile.cjs changed",
  );
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    ".pnpmfile.cjs changed",
  );
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    "ui-dashboard/.npmrc changed",
  );
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    "alerts/infra/onchain-event-handler/pnpm-lock.yaml changed",
  );
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    ".node-version changed",
  );
});

test("classifies workspace package manifests as package-manager risk", () => {
  const report = analyzeMateriality({
    paths: ["ui-dashboard/package.json"],
  });

  assertEqual(report.tier, "full");
  assertEqual(report.contextUpdateRequired, true);
  assertEqual(report.contextUpdateMissing, true);
  assertIncludes(
    report.contextReasons.map((reason) => reason.detail).join("\n"),
    "ui-dashboard/package.json changed",
  );
});

test("classifies stateful indexer and dashboard data-flow paths as full", () => {
  const report = analyzeMateriality({
    paths: [
      "indexer-envio/schema.graphql",
      "indexer-envio/src/EventHandlersBridgeOnly.ts",
      "ui-dashboard/src/lib/queries/liquity.ts",
      "ui-dashboard/src/lib/use-table-sort.ts",
    ],
  });

  assertEqual(report.tier, "full");
});

test("classifies Aegis runtime and deploy paths as full", () => {
  const report = analyzeMateriality({
    paths: [
      "aegis/app.yaml",
      "aegis/config.yaml",
      "aegis/grafana-agent/config.alloy",
      "aegis/bin/deploy.ts",
    ],
  });

  assertEqual(report.tier, "full");
});

test("line-count threshold promotes otherwise simple docs to standard", () => {
  const report = analyzeMateriality({
    paths: ["docs/notes/example.md"],
    numstat: stats({
      "docs/notes/example.md": { additions: 201, deletions: 0 },
    }),
  });

  assertEqual(report.tier, "standard");
});

test("parseArgs supports base/head/json and changed-path file", () => {
  const parsed = parseArgs([
    "--base",
    "origin/main",
    "--head",
    "HEAD",
    "--changed-paths-file",
    "/tmp/paths.txt",
    "--json",
  ]);

  assertEqual(parsed.base, "origin/main");
  assertEqual(parsed.head, "HEAD");
  assertEqual(parsed.changedPathsFile, "/tmp/paths.txt");
  assertEqual(parsed.json, true);
});

test("renderHuman reports required but present context updates", () => {
  const rendered = renderHuman(
    analyzeMateriality({
      paths: ["package.json", "AGENTS.md"],
      scriptChanges: [
        {
          name: "agent:review-materiality",
          before: null,
          after: "node scripts/review-materiality.mjs",
          kind: "added",
        },
      ],
    }),
  );

  assertIncludes(rendered, "Review materiality: full");
  assertIncludes(rendered, "Context update: required and present");
});

test("CLI reads changed paths from file and emits JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-test-"));
  const pathsFile = join(dir, "paths.txt");
  writeFileSync(pathsFile, "docs/PLAN-ai-review-process.md\n", "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [
        new URL("./review-materiality.mjs", import.meta.url).pathname,
        "--changed-paths-file",
        pathsFile,
        "--json",
      ],
      { encoding: "utf8" },
    );
    assertEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assertEqual(parsed.tier, "trivial");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI accumulates line counts across committed and unstaged changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-git-test-"));
  const script = new URL("./review-materiality.mjs", import.meta.url).pathname;

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    writeFileSync(join(dir, "example.md"), "one\n", "utf8");
    git(dir, ["add", "example.md"]);
    git(dir, ["commit", "-m", "base"]);

    writeFileSync(join(dir, "example.md"), "one\ntwo\n", "utf8");
    git(dir, ["add", "example.md"]);
    git(dir, ["commit", "-m", "head"]);
    // Unstaged: triggers the head === "HEAD" numstat accumulation branch.
    writeFileSync(join(dir, "example.md"), "one\ntwo\nthree\n", "utf8");

    const result = spawnSync(
      process.execPath,
      [script, "--base", "HEAD~1", "--head", "HEAD", "--json"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assertEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assertEqual(parsed.changedFileCount, 1);
    assertEqual(parsed.lineChanges.additions, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI falls back to two-dot diff when triple-dot has no merge base", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-git-test-"));
  const script = new URL("./review-materiality.mjs", import.meta.url).pathname;

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    writeFileSync(join(dir, "base.md"), "base\n", "utf8");
    git(dir, ["add", "base.md"]);
    git(dir, ["commit", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]).trim();

    git(dir, ["checkout", "--orphan", "feature"]);
    git(dir, ["rm", "-rf", "."]);
    writeFileSync(join(dir, "feature.md"), "feature\n", "utf8");
    git(dir, ["add", "feature.md"]);
    git(dir, ["commit", "-m", "feature"]);

    const result = spawnSync(
      process.execPath,
      [script, "--base", base, "--head", "HEAD", "--json"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assertEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assertEqual(parsed.changedFileCount, 2);
    assertEqual(parsed.lineChanges.additions, 1);
    assertEqual(parsed.lineChanges.deletions, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI fails when neither triple-dot nor two-dot diff can read the base", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-git-test-"));
  const script = new URL("./review-materiality.mjs", import.meta.url).pathname;

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    writeFileSync(join(dir, "example.md"), "one\n", "utf8");
    git(dir, ["add", "example.md"]);
    git(dir, ["commit", "-m", "base"]);

    const result = spawnSync(
      process.execPath,
      [script, "--base", "missing/ref", "--head", "HEAD", "--json"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert(result.status !== 0, "expected missing base ref to fail");
    assertIncludes(
      result.stderr,
      "unable to read git diff for missing/ref..HEAD",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI counts untracked files without trailing newlines", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-git-test-"));
  const script = new URL("./review-materiality.mjs", import.meta.url).pathname;

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    writeFileSync(join(dir, "tracked.md"), "tracked\n", "utf8");
    git(dir, ["add", "tracked.md"]);
    git(dir, ["commit", "-m", "base"]);
    writeFileSync(join(dir, "untracked.md"), "one", "utf8");

    const result = spawnSync(
      process.execPath,
      [script, "--base", "HEAD", "--head", "HEAD", "--json"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assertEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assertEqual(parsed.changedFileCount, 1);
    assertEqual(parsed.lineChanges.additions, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI fails when script comparison cannot read base package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-materiality-git-test-"));
  const script = new URL("./review-materiality.mjs", import.meta.url).pathname;
  const pathsFile = join(dir, "paths.txt");

  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "true" } }, null, 2),
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    git(dir, ["commit", "-m", "base"]);
    writeFileSync(pathsFile, "package.json\n", "utf8");

    const result = spawnSync(
      process.execPath,
      [
        script,
        "--changed-paths-file",
        pathsFile,
        "--base",
        "missing/ref",
        "--head",
        "HEAD",
        "--json",
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert(result.status !== 0, "expected missing package.json base to fail");
    assertIncludes(result.stderr, "unable to read package.json at missing/ref");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
