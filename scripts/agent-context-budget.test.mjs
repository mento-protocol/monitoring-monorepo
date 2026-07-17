#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContextBudgetReport,
  DEFAULT_LIMIT_BYTES,
  MAX_ROUTE_LIMIT_BYTES,
  parseProjectDocMaxBytes,
  ROOT_INSTRUCTION_LIMIT_BYTES,
  resolveProjectDocMaxBytes,
  SCOPED_INSTRUCTION_LIMIT_BYTES,
  selectEffectiveInstructionFiles,
  trackedInstructionFiles,
  WARNING_PERCENT,
} from "./agent-context-budget.mjs";

const scriptPath = fileURLToPath(
  new URL("./agent-context-budget.mjs", import.meta.url),
);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

function withRepo(fn) {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-context-budget-"));
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

function track(repo, ...files) {
  execFileSync("git", ["add", "--", ...files], { cwd: repo });
}

test("project_doc_max_bytes defaults when config or key is absent", () => {
  withRepo((repo) => {
    assert.equal(resolveProjectDocMaxBytes(repo), DEFAULT_LIMIT_BYTES);
    write(repo, ".codex/config.toml", '[mcp_servers.example]\ncommand = "x"\n');
    assert.equal(resolveProjectDocMaxBytes(repo), DEFAULT_LIMIT_BYTES);
  });
});

test("project_doc_max_bytes accepts TOML integer separators", () => {
  assert.equal(
    parseProjectDocMaxBytes("project_doc_max_bytes = 65_536\n"),
    65_536,
  );
});

test("project_doc_max_bytes rejects invalid and duplicate values", () => {
  assert.throws(
    () => parseProjectDocMaxBytes('project_doc_max_bytes = "large"\n'),
    /positive TOML integer/,
  );
  assert.throws(
    () =>
      parseProjectDocMaxBytes(
        "project_doc_max_bytes = 10\nproject_doc_max_bytes = 20\n",
      ),
    /exactly once/,
  );
  for (const invalid of ["_100", "100_", "10__00"]) {
    assert.throws(
      () => parseProjectDocMaxBytes(`project_doc_max_bytes = ${invalid}\n`),
      /positive TOML integer/,
    );
  }
  assert.throws(
    () =>
      parseProjectDocMaxBytes(
        "[mcp_servers.example]\nproject_doc_max_bytes = 4096\n",
      ),
    /top-level key/,
  );
  assert.throws(
    () =>
      parseProjectDocMaxBytes("[[plugins]]\nproject_doc_max_bytes = 4096\n"),
    /top-level key/,
  );
});

test("unreadable config surfaces a direct filesystem error", () => {
  withRepo((repo) => {
    mkdirSync(path.join(repo, ".codex", "config.toml"), { recursive: true });
    assert.throws(
      () => resolveProjectDocMaxBytes(repo),
      /EISDIR|illegal operation/i,
    );
  });
});

test("override instructions replace AGENTS.md in the same directory", () => {
  assert.deepEqual(
    selectEffectiveInstructionFiles([
      "AGENTS.md",
      "pkg/AGENTS.md",
      "pkg/AGENTS.override.md",
      "pkg/CLAUDE.md",
    ]),
    ["AGENTS.md", "pkg/AGENTS.override.md"],
  );
});

test("instruction discovery models additions and deletions in the proposed tree", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "removed");
    write(repo, "ignored/AGENTS.md", "ignored");
    write(repo, ".gitignore", "ignored/\n");
    track(repo, "AGENTS.md", ".gitignore");
    rmSync(path.join(repo, "AGENTS.md"));
    write(repo, "pkg/AGENTS.md", "new");
    assert.deepEqual(trackedInstructionFiles(repo), ["pkg/AGENTS.md"]);
  });
});

test("report models root plus nested chains and largest contributors", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "r".repeat(10));
    write(repo, "pkg/AGENTS.md", "p".repeat(20));
    write(repo, "pkg/deep/AGENTS.md", "d".repeat(5));
    const report = buildContextBudgetReport({
      repoRoot: repo,
      files: ["AGENTS.md", "pkg/AGENTS.md", "pkg/deep/AGENTS.md"],
      limitBytes: 40,
    });
    assert.deepEqual(
      report.routes.map(({ route, bytes }) => [route, bytes]),
      [
        [".", 10],
        ["pkg", 32],
        ["pkg/deep", 39],
      ],
    );
    assert.equal(report.routes[2].content_bytes, 35);
    assert.equal(report.routes[2].separator_bytes, 4);
    assert.equal(report.routes[2].contributors[0].path, "pkg/AGENTS.md");
    assert.deepEqual(report.oversized_routes, []);
  });
});

test("empty instruction files are skipped like Codex discovery", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "");
    write(repo, "pkg/AGENTS.md", "local");
    const report = buildContextBudgetReport({
      repoRoot: repo,
      files: ["AGENTS.md", "pkg/AGENTS.md"],
      limitBytes: 100,
    });
    assert.deepEqual(
      report.instruction_files.map(({ path: file }) => file),
      ["pkg/AGENTS.md"],
    );
    assert.deepEqual(report.routes[0].chain, [
      { path: "pkg/AGENTS.md", bytes: 5 },
    ]);
  });
});

test("exact limit passes and one byte over fails", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "12345");
    const exact = buildContextBudgetReport({
      repoRoot: repo,
      files: ["AGENTS.md"],
      limitBytes: 5,
    });
    const over = buildContextBudgetReport({
      repoRoot: repo,
      files: ["AGENTS.md"],
      limitBytes: 4,
    });
    assert.equal(exact.routes[0].oversized, false);
    assert.equal(over.routes[0].oversized, true);
    assert.equal(over.routes[0].headroom_bytes, -1);
  });
});

test("warning threshold is visible but non-blocking", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "x".repeat(90));
    const report = buildContextBudgetReport({
      repoRoot: repo,
      files: ["AGENTS.md"],
      limitBytes: 100,
      rootLimitBytes: 100,
      scopedLimitBytes: 100,
      warningPercent: 90,
    });
    assert.equal(report.instruction_files[0].state, "warning");
    assert.equal(report.routes[0].state, "warning");
    assert.deepEqual(report.warning_instruction_files, ["AGENTS.md"]);
    assert.deepEqual(report.warning_routes, ["."]);
    assert.deepEqual(report.oversized_instruction_files, []);
    assert.deepEqual(report.oversized_routes, []);
  });
});

test("file caps fail independently of aggregate route headroom", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "x".repeat(11));
    const report = buildContextBudgetReport({
      repoRoot: repo,
      files: ["AGENTS.md"],
      limitBytes: 100,
      rootLimitBytes: 10,
      scopedLimitBytes: 20,
    });
    assert.deepEqual(report.oversized_instruction_files, ["AGENTS.md"]);
    assert.deepEqual(report.oversized_routes, []);
  });
});

test("tracked symlink is measured by resolved content and CLAUDE mirrors are ignored", () => {
  withRepo((repo) => {
    write(repo, "source.md", "1234567");
    symlinkSync("source.md", path.join(repo, "AGENTS.md"));
    write(repo, "CLAUDE.md", "ignored");
    track(repo, "source.md", "AGENTS.md", "CLAUDE.md");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--root",
        repo,
        "--limit",
        String(MAX_ROUTE_LIMIT_BYTES),
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.routes.length, 1);
    assert.equal(report.routes[0].bytes, 7);
  });
});

test("strict CLI reports oversize with exit one while report mode stays zero", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "12345");
    track(repo, "AGENTS.md");
    const report = spawnSync(process.execPath, [
      scriptPath,
      "--root",
      repo,
      "--limit",
      "4",
    ]);
    const strict = spawnSync(process.execPath, [
      scriptPath,
      "--root",
      repo,
      "--limit",
      "4",
      "--strict",
    ]);
    assert.equal(report.status, 0);
    assert.equal(strict.status, 1);
  });
});

test("strict CLI reports an actionable root-file violation", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "x".repeat(ROOT_INSTRUCTION_LIMIT_BYTES + 1));
    track(repo, "AGENTS.md");
    const strict = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--root",
        repo,
        "--limit",
        String(MAX_ROUTE_LIMIT_BYTES),
        "--strict",
      ],
      { encoding: "utf8" },
    );
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(
      strict.stdout,
      /AGENTS\.md exceeds its root file cap by 1 byte/,
    );
    assert.match(strict.stdout, /do not raise the cap/);
  });
});

test("CLI uses the repository route policy when config omits a limit", () => {
  for (const config of [null, '[mcp_servers.example]\ncommand = "x"\n']) {
    withRepo((repo) => {
      write(repo, "AGENTS.md", "small");
      if (config !== null) write(repo, ".codex/config.toml", config);
      track(repo, "AGENTS.md");
      const result = spawnSync(
        process.execPath,
        [scriptPath, "--root", repo, "--json", "--strict"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        JSON.parse(result.stdout).limit_bytes,
        MAX_ROUTE_LIMIT_BYTES,
      );
    });
  }
});

test("CLI refuses a configured route cap above repository policy", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "small");
    write(
      repo,
      ".codex/config.toml",
      `project_doc_max_bytes = ${DEFAULT_LIMIT_BYTES}\n`,
    );
    track(repo, "AGENTS.md");
    const strict = spawnSync(
      process.execPath,
      [scriptPath, "--root", repo, "--strict"],
      { encoding: "utf8" },
    );
    assert.equal(strict.status, 2);
    assert.match(strict.stderr, /exceeds the repository policy maximum/);
  });
});

test("repository instruction files and every supported package route satisfy policy", () => {
  const configuredLimit = resolveProjectDocMaxBytes(repoRoot);
  assert.ok(configuredLimit <= MAX_ROUTE_LIMIT_BYTES);
  const report = buildContextBudgetReport({
    repoRoot,
    files: trackedInstructionFiles(repoRoot),
    limitBytes: configuredLimit,
  });
  assert.deepEqual(
    report.routes.map(({ route }) => route),
    [
      ".",
      "aegis",
      "alerts",
      "indexer-envio",
      "integration-probes",
      "metrics-bridge",
      "scripts",
      "shared-config",
      "terraform",
      "ui-dashboard",
    ],
  );
  assert.equal(
    report.root_instruction_limit_bytes,
    ROOT_INSTRUCTION_LIMIT_BYTES,
  );
  assert.equal(
    report.scoped_instruction_limit_bytes,
    SCOPED_INSTRUCTION_LIMIT_BYTES,
  );
  assert.equal(report.warning_percent, WARNING_PERCENT);
  assert.deepEqual(report.oversized_instruction_files, []);
  assert.deepEqual(report.oversized_routes, []);
});
