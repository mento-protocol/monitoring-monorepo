#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDocumentationInventory,
  classifyDocumentation,
  extractMarkdownTargets,
  isDocumentationPath,
  parseDocumentationMetadata,
  renderDocumentationIndex,
  trackedDocumentationFiles,
} from "./docs-index-helpers.mjs";

const scriptPath = fileURLToPath(new URL("./docs-index.mjs", import.meta.url));

function withRepo(fn) {
  const repo = mkdtempSync(path.join(tmpdir(), "docs-index-"));
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

function run(repo, ...args) {
  return spawnSync(process.execPath, [scriptPath, "--root", repo, ...args], {
    encoding: "utf8",
  });
}

test("parses frontmatter and hidden README metadata", () => {
  assert.equal(
    parseDocumentationMetadata(
      "doc.md",
      "---\ntitle: One\ncanonical: false\n---\n# X\n",
    ).title,
    "One",
  );
  const readme = parseDocumentationMetadata(
    "pkg/README.md",
    '<!-- agent-context: title="Package" status=active owner=eng canonical=true last_verified=2026-07-17 -->',
  );
  assert.equal(readme.title, "Package");
  assert.equal(readme.canonical, "true");
});

test("excludes CLAUDE and mirrored Claude skills", () => {
  assert.equal(isDocumentationPath("CLAUDE.md"), false);
  assert.equal(isDocumentationPath("pkg/CLAUDE.md"), false);
  assert.equal(isDocumentationPath(".claude/skills/ship/SKILL.md"), false);
  assert.equal(isDocumentationPath(".claude/commands/verify.md"), true);
});

test("working-tree deletions leave the generated inventory", () => {
  withRepo((repo) => {
    write(repo, "removed.md", "# Removed\n");
    track(repo, "removed.md");
    rmSync(path.join(repo, "removed.md"));
    assert.deepEqual(trackedDocumentationFiles(repo), []);
  });
});

test("non-ignored untracked Markdown enters the proposed inventory", () => {
  withRepo((repo) => {
    write(repo, ".gitignore", "ignored.md\n");
    track(repo, ".gitignore");
    write(repo, "docs/new-guide.md", "# New guide\n");
    write(repo, "ignored.md", "# Ignored\n");
    assert.deepEqual(trackedDocumentationFiles(repo), ["docs/new-guide.md"]);
  });
});

test("classification is single-valued and explicit metadata overrides defaults", () => {
  assert.deepEqual(
    classifyDocumentation("docs/adr/0001-test.md").garden_lane,
    "adrs-architecture",
  );
  assert.equal(
    classifyDocumentation("pkg/AGENTS.md").doc_type,
    "agent-instructions",
  );
  const override = classifyDocumentation("docs/notes/example.md", {
    doc_type: "reference",
    garden_lane: "package-readmes-reference",
    review_interval_days: "30",
  });
  assert.equal(override.doc_type, "reference");
  assert.equal(override.garden_lane, "package-readmes-reference");
  assert.equal(override.review_interval_days, 30);
  assert.deepEqual(override.errors, []);
});

test("extracts links but ignores inline-code and both fenced-code styles", () => {
  const targets = extractMarkdownTargets(
    "[one](./one.md)\n[two]: ../two.md\n`[inline](inline.md)`\n```md\n[fenced](missing.md)\n```\n~~~md\n[tilde](also-missing.md)\n~~~\n",
  );
  assert.deepEqual(targets, ["./one.md", "../two.md"]);
});

test("inventory rejects in-repo symlinks that resolve outside the repository", () => {
  withRepo((repo) => {
    const outside = mkdtempSync(path.join(tmpdir(), "docs-index-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.md"), "# Outside\n");
      symlinkSync(
        path.join(outside, "secret.md"),
        path.join(repo, "outside.md"),
      );
      write(repo, "guide.md", "# Guide\n\n[Outside](outside.md)\n");
      const inventory = buildDocumentationInventory({
        repoRoot: repo,
        files: ["guide.md"],
      });
      assert.deepEqual(inventory.broken_links, [
        {
          source: "guide.md",
          target: "outside.md",
          reason: "target resolves outside repository root",
        },
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("inventory rejects directory symlinks that resolve outside the repository", () => {
  withRepo((repo) => {
    const outside = mkdtempSync(path.join(tmpdir(), "docs-index-outside-dir-"));
    try {
      symlinkSync(outside, path.join(repo, "outside-dir"));
      write(repo, "guide.md", "# Guide\n\n[Outside](outside-dir)\n");
      const inventory = buildDocumentationInventory({
        repoRoot: repo,
        files: ["guide.md"],
      });
      assert.deepEqual(inventory.broken_links, [
        {
          source: "guide.md",
          target: "outside-dir",
          reason: "target resolves outside repository root",
        },
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("inventory reports stable ordering, inbound sources, archived state, and broken links", () => {
  withRepo((repo) => {
    write(repo, "README.md", "# Root\n\n[Guide](docs/guide.md)\n");
    write(
      repo,
      "docs/guide.md",
      "---\ntitle: Guide\nstatus: archived\nowner: eng\ncanonical: false\n---\n# Guide\n\n[Missing](missing.md)\n",
    );
    const inventory = buildDocumentationInventory({
      repoRoot: repo,
      files: ["docs/guide.md", "README.md"],
    });
    assert.deepEqual(
      inventory.records.map((record) => record.path),
      ["docs/guide.md", "README.md"],
    );
    assert.equal(inventory.records[0].status, "archived");
    assert.equal(inventory.records[0].inbound_links, 1);
    assert.deepEqual(inventory.broken_links, [
      {
        source: "docs/guide.md",
        target: "missing.md",
        reason: "target does not exist",
      },
    ]);
  });
});

test("canonical documents must declare their classification fields", () => {
  withRepo((repo) => {
    write(
      repo,
      "docs/guide.md",
      "---\ntitle: Guide\nstatus: active\nowner: eng\ncanonical: true\nlast_verified: 2026-07-17\n---\n# Guide\n",
    );
    const inventory = buildDocumentationInventory({
      repoRoot: repo,
      files: ["docs/guide.md"],
    });
    assert.deepEqual(inventory.warnings, [
      "docs/guide.md: canonical document is missing 'doc_type'",
      "docs/guide.md: canonical document is missing 'garden_lane'",
      "docs/guide.md: canonical document is missing 'review_interval_days'",
      "docs/guide.md: canonical document is missing 'scope'",
    ]);
  });
});

test("managed documents reject invalid lifecycle status", () => {
  withRepo((repo) => {
    write(
      repo,
      "docs/guide.md",
      "---\ntitle: Guide\nstatus: forgotten\nowner: eng\ncanonical: false\n---\n# Guide\n",
    );
    const inventory = buildDocumentationInventory({
      repoRoot: repo,
      files: ["docs/guide.md"],
    });
    assert.deepEqual(inventory.warnings, [
      "docs/guide.md: invalid status 'forgotten'",
    ]);
  });
});

test("importing the CLI has no side effects", () => {
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(scriptPath).href)})`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});

test("render groups documents in deterministic lane order", () => {
  withRepo((repo) => {
    write(repo, "AGENTS.md", "# Rules\n");
    write(repo, "README.md", "# Root\n");
    const inventory = buildDocumentationInventory({
      repoRoot: repo,
      files: ["README.md", "AGENTS.md"],
    });
    const rendered = renderDocumentationIndex(inventory, {
      lastVerified: "2026-07-17",
    });
    assert.ok(
      rendered.indexOf("## agent-entry-points") <
        rendered.indexOf("## operator-runbooks"),
    );
    assert.ok(rendered.includes("`AGENTS.md`"));
  });
});

test("write converges with the generated index included and check detects drift", () => {
  withRepo((repo) => {
    write(
      repo,
      "README.md",
      '# Root\n\n<!-- agent-context: title="Root" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=reference scope=repo-wide review_interval_days=90 garden_lane=package-readmes-reference -->\n',
    );
    write(repo, "docs/context-standards.md", "# Context\n");
    track(repo, "README.md", "docs/context-standards.md");
    const written = run(repo, "--write");
    assert.equal(written.status, 0, written.stderr);
    const checked = run(repo, "--check");
    assert.equal(checked.status, 0, checked.stderr);
    assert.ok(
      readFileSync(path.join(repo, "docs/README.md"), "utf8").includes(
        "Documentation Catalog",
      ),
    );
    write(repo, "docs/temporary.md", "# Temporary\n");
    track(repo, "docs/temporary.md");
    assert.equal(run(repo, "--write").status, 0);
    rmSync(path.join(repo, "docs/temporary.md"));
    const repaired = run(repo, "--write");
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.doesNotMatch(
      readFileSync(path.join(repo, "docs/README.md"), "utf8"),
      /temporary\.md/,
    );
    write(repo, "README.md", "# Root changed\n");
    const stale = run(repo, "--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /is stale/);
  });
});

test("check fails for broken internal links", () => {
  withRepo((repo) => {
    write(repo, "README.md", "# Root\n\n[Missing](missing.md)\n");
    track(repo, "README.md");
    const result = run(repo, "--check");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /broken link/);
  });
});

test("write repairs the catalog while reporting unrelated broken links", () => {
  withRepo((repo) => {
    write(
      repo,
      "README.md",
      '# Root\n\n<!-- agent-context: title="Root" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=reference scope=repo-wide review_interval_days=90 garden_lane=package-readmes-reference -->\n\n[Missing](missing.md)\n',
    );
    write(repo, "docs/.gitkeep", "");
    track(repo, "README.md", "docs/.gitkeep");
    const result = run(repo, "--write");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /wrote docs\/README\.md/);
    assert.match(result.stderr, /broken link/);
    assert.match(
      readFileSync(path.join(repo, "docs/README.md"), "utf8"),
      /Documentation Catalog/,
    );
  });
});
