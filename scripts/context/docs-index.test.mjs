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
  CLAUDE_RUNTIME_DOCUMENT_PATHS,
  CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
  CLAUDE_RUNTIME_DOCUMENT_REGISTRY_VERSION,
} from "./claude-runtime-document-registry.mjs";
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

function runtimeRegistryDocuments(source = "AGENTS.md") {
  return CLAUDE_RUNTIME_DOCUMENT_PATHS.map((file) => ({
    path: file,
    title: path.posix.basename(file),
    canonical: false,
    status: "active",
    owner: "eng",
    scope: "repo-wide",
    doc_type: file.includes("/agents/") ? "role" : "command",
    garden_lane: "agent-entry-points",
    review_interval_days: 180,
    canonical_sources: [source],
  }));
}

function writeRuntimeRegistryFixture(repo) {
  write(
    repo,
    "AGENTS.md",
    "---\ntitle: Rules\nstatus: active\nowner: eng\ncanonical: true\nlast_verified: 2026-07-17\ndoc_type: agent-instructions\nscope: repo-wide\nreview_interval_days: 90\ngarden_lane: agent-entry-points\n---\n# Rules\n",
  );
  for (const file of CLAUDE_RUNTIME_DOCUMENT_PATHS) {
    write(repo, file, `# ${path.posix.basename(file)}\n`);
  }
  const registry = {
    schema_version: CLAUDE_RUNTIME_DOCUMENT_REGISTRY_VERSION,
    documents: runtimeRegistryDocuments(),
  };
  write(
    repo,
    CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  return {
    files: ["AGENTS.md", ...CLAUDE_RUNTIME_DOCUMENT_PATHS],
    registry,
  };
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

test("excludes the review evaluation's machine payload", () => {
  // docs/README.md is a bootstrap source of the navigation evaluation, so every
  // catalog entry spends the shared context reserve. Frozen contestant
  // transcripts and judge prompts are not documents, and the run directories
  // would add one generated report per paid run forever — an unbounded drip
  // against a fixed reserve. The runbook that explains the evaluation is a
  // document and stays indexed.
  assert.equal(
    isDocumentationPath(
      "docs/evals/review-skill-finder-reports/pr-1990-draw1.md",
    ),
    false,
  );
  assert.equal(
    isDocumentationPath(
      "docs/evals/review-skill-runs/2026-09-08-abc/report.md",
    ),
    false,
  );
  assert.equal(
    isDocumentationPath("scripts/review/prompts/judge-match.md"),
    false,
  );
  assert.equal(isDocumentationPath("docs/evals/review-skill.md"), true);
  assert.equal(
    isDocumentationPath("docs/evals/documentation-navigation.md"),
    true,
  );
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
  for (const file of [
    "governance-watchdog/ADDING_EVENTS.md",
    "governance-watchdog/DEPLOY_FROM_SCRATCH.md",
  ]) {
    assert.equal(
      classifyDocumentation(file).garden_lane,
      "operator-runbooks",
      file,
    );
  }
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

test("Claude runtime registry gives every projection owned non-canonical metadata", () => {
  withRepo((repo) => {
    const { files } = writeRuntimeRegistryFixture(repo);
    const first = buildDocumentationInventory({ repoRoot: repo, files });
    const second = buildDocumentationInventory({ repoRoot: repo, files });
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first, second);
    const runtimeRecords = first.records.filter((record) =>
      CLAUDE_RUNTIME_DOCUMENT_PATHS.includes(record.path),
    );
    assert.equal(runtimeRecords.length, CLAUDE_RUNTIME_DOCUMENT_PATHS.length);
    for (const record of runtimeRecords) {
      assert.equal(record.authority, "non-canonical");
      assert.equal(record.status, "active");
      assert.equal(record.owner, "eng");
      assert.deepEqual(record.canonical_sources, ["AGENTS.md"]);
    }
    const rendered = renderDocumentationIndex(first, {
      lastVerified: "2026-07-17",
    });
    assert.match(rendered, /Authority: non-canonical/);
    assert.match(rendered, /; sources:/);
    assert.match(rendered, /\[`AGENTS\.md`\]/);
  });
});

// docs/context-standards.md states the registry's size in prose, and nothing
// recomputed it when ADR 0086 removed a runtime document. Pin the prose to the
// list, so the next added or removed runtime document reds here.
const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

test("context-standards states the registry's current size", () => {
  const count = COUNT_WORDS[CLAUDE_RUNTIME_DOCUMENT_PATHS.length];
  assert.ok(count, "the registry outgrew the spelled-out counts");
  const standards = readFileSync(
    fileURLToPath(new URL("../../docs/context-standards.md", import.meta.url)),
    "utf8",
  );
  for (const sentence of [
    `Their ${count} supported paths are instead registered in`,
    `registry limited to its ${count} named Claude runtime documents`,
  ]) {
    assert.ok(
      standards.includes(sentence),
      `docs/context-standards.md does not say "${sentence}"`,
    );
  }
});

test("Claude runtime registry fails closed for invalid entries and proposed-tree drift", () => {
  withRepo((repo) => {
    const { files, registry } = writeRuntimeRegistryFixture(repo);
    registry.documents[0].owner = "";
    registry.documents[1].canonical_sources = ["docs/missing.md"];
    write(
      repo,
      CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    write(repo, ".claude/commands/unregistered.md", "# Unregistered\n");
    rmSync(path.join(repo, CLAUDE_RUNTIME_DOCUMENT_PATHS[2]));
    const inventory = buildDocumentationInventory({
      repoRoot: repo,
      files: [
        ...files.filter((file) => file !== CLAUDE_RUNTIME_DOCUMENT_PATHS[2]),
        ".claude/commands/unregistered.md",
      ],
    });
    assert.match(
      inventory.errors.join("\n"),
      /'owner' must be a non-empty string/,
    );
    assert.match(
      inventory.errors.join("\n"),
      /canonical source 'docs\/missing\.md' is missing from the proposed tree/,
    );
    assert.match(
      inventory.errors.join("\n"),
      /runtime document is missing from the proposed tree/,
    );
    assert.match(
      inventory.errors.join("\n"),
      /unregistered Claude runtime document/,
    );
  });
});

test("Claude runtime registry must be a proposed regular repository file", () => {
  withRepo((repo) => {
    const { files } = writeRuntimeRegistryFixture(repo);
    write(repo, ".gitignore", `${CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH}\n`);
    track(repo, ".gitignore");
    const ignored = buildDocumentationInventory({ repoRoot: repo, files });
    assert.match(
      ignored.errors.join("\n"),
      /registry is missing from the proposed tree/,
    );
  });

  withRepo((repo) => {
    const { files } = writeRuntimeRegistryFixture(repo);
    const registryPath = path.join(repo, CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH);
    const registryContent = readFileSync(registryPath, "utf8");
    rmSync(registryPath);
    write(repo, "registry-target.json", registryContent);
    symlinkSync(path.join(repo, "registry-target.json"), registryPath);
    const symlinked = buildDocumentationInventory({ repoRoot: repo, files });
    assert.match(symlinked.errors.join("\n"), /registry is not a regular file/);
  });
});

test("Claude runtime projections cannot serve as canonical sources", () => {
  withRepo((repo) => {
    const { files, registry } = writeRuntimeRegistryFixture(repo);
    const runtimeSource = CLAUDE_RUNTIME_DOCUMENT_PATHS[0];
    write(
      repo,
      runtimeSource,
      "---\ntitle: Runtime\nstatus: active\nowner: eng\ncanonical: true\nlast_verified: 2026-07-26\n---\n# Runtime\n",
    );
    registry.documents[1].canonical_sources = [runtimeSource];
    write(
      repo,
      CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    const inventory = buildDocumentationInventory({ repoRoot: repo, files });
    assert.match(
      inventory.errors.join("\n"),
      /canonical source '.claude\/agents\/dashboard-explorer\.md' is a Claude runtime projection/,
    );
  });
});

test("Claude runtime registry rejects non-string scalar metadata", () => {
  withRepo((repo) => {
    const { files, registry } = writeRuntimeRegistryFixture(repo);
    const scalarFields = [
      "path",
      "title",
      "owner",
      "scope",
      "status",
      "doc_type",
      "garden_lane",
    ];
    // The registry is shorter than this field list, and its length moves when a
    // runtime document is added or removed. Wrap so every field still lands on
    // a real document; the validator reports each failing field separately, so
    // two fields on one document still produce two errors.
    for (const [index, field] of scalarFields.entries()) {
      registry.documents[index % registry.documents.length][field] =
        index % 2 === 0 ? [] : {};
    }
    write(
      repo,
      CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    const errors = buildDocumentationInventory({
      repoRoot: repo,
      files,
    }).errors.join("\n");
    for (const field of scalarFields) {
      assert.match(
        errors,
        new RegExp(`'${field}' must be a non-empty string`),
        field,
      );
    }
  });
});

test("Claude runtime registry reports malformed source lists in every render mode", () => {
  for (const canonicalSources of ["AGENTS.md", {}, [42]]) {
    withRepo((repo) => {
      const { files, registry } = writeRuntimeRegistryFixture(repo);
      registry.documents[0].canonical_sources = canonicalSources;
      write(
        repo,
        CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
        `${JSON.stringify(registry, null, 2)}\n`,
      );
      track(repo, ...files, CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH);

      const printResult = run(repo);
      assert.equal(printResult.status, 1);
      assert.doesNotMatch(printResult.stderr, /TypeError/);
      assert.match(
        printResult.stderr,
        /canonical_sources must be non-empty|invalid canonical source '42'/,
      );

      const jsonResult = run(repo, "--json");
      assert.equal(jsonResult.status, 1);
      assert.doesNotMatch(jsonResult.stderr, /TypeError/);
      const inventory = JSON.parse(jsonResult.stdout);
      assert.match(
        inventory.errors.join("\n"),
        /canonical_sources must be non-empty|invalid canonical source '42'/,
      );

      const checkResult = run(repo, "--check");
      assert.equal(checkResult.status, 1);
      assert.doesNotMatch(checkResult.stderr, /TypeError/);
      assert.match(
        checkResult.stderr,
        /canonical_sources must be non-empty|invalid canonical source '42'/,
      );
    });
  }
});

test("Claude runtime registry rejects unknown top-level and document keys", () => {
  withRepo((repo) => {
    const { files, registry } = writeRuntimeRegistryFixture(repo);
    registry.typo_field = true;
    registry.documents[0].typo_field = "ignored";
    write(
      repo,
      CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    const errors = buildDocumentationInventory({
      repoRoot: repo,
      files,
    }).errors.join("\n");
    assert.match(errors, /unknown top-level key 'typo_field'/);
    assert.match(
      errors,
      /\.claude\/agents\/dashboard-explorer\.md: unknown key 'typo_field'/,
    );
  });
});

test("Claude runtime registry reports every malformed path-less entry", () => {
  withRepo((repo) => {
    const { files, registry } = writeRuntimeRegistryFixture(repo);
    delete registry.documents[0].path;
    delete registry.documents[1].path;
    registry.documents[0].owner = "";
    registry.documents[1].scope = "";
    write(
      repo,
      CLAUDE_RUNTIME_DOCUMENT_REGISTRY_PATH,
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    const errors = buildDocumentationInventory({
      repoRoot: repo,
      files,
    }).errors.join("\n");
    assert.match(errors, /entry: 'owner' must be a non-empty string/);
    assert.match(errors, /entry: 'scope' must be a non-empty string/);
    assert.doesNotMatch(errors, /entry: duplicate runtime path/);
  });
});

test("Claude runtime registry classification leaves live runtime bytes unchanged", () => {
  const repo = path.resolve(path.dirname(scriptPath), "..", "..");
  const files = trackedDocumentationFiles(repo);
  const before = new Map(
    CLAUDE_RUNTIME_DOCUMENT_PATHS.map((file) => [
      file,
      readFileSync(path.join(repo, file), "utf8"),
    ]),
  );
  const inventory = buildDocumentationInventory({ repoRoot: repo, files });
  assert.deepEqual(inventory.errors, []);
  for (const [file, content] of before) {
    assert.equal(readFileSync(path.join(repo, file), "utf8"), content, file);
  }
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
      "---\ntitle: Guide\nstatus: archived\nowner: eng\ncanonical: false\n---\n# Guide\n\n[Self](./guide.md#guide)\n[Missing](missing.md)\n",
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
    assert.match(rendered, /Authority: unmanaged/);
    assert.doesNotMatch(rendered, /\| Document \| Title \|/);
    assert.doesNotMatch(rendered, /unique documents|Words \/ inbound/);
  });
});

test("render keeps ADR titles while using source paths for other documents", () => {
  withRepo((repo) => {
    write(
      repo,
      "docs/notes/example.md",
      "---\ntitle: Example note\nstatus: archived\nowner: eng\ncanonical: false\ndoc_type: note\nscope: repo-wide\nreview_interval_days: 180\ngarden_lane: notes-plans-archive\n---\n# Example note\n",
    );
    write(
      repo,
      "docs/adr/0001-example.md",
      "---\ntitle: Example decision\nstatus: active\nowner: eng\ncanonical: true\nlast_verified: 2026-07-17\ndoc_type: adr\nscope: repo-wide\nreview_interval_days: 90\ngarden_lane: adrs-architecture\n---\n# Example decision\n",
    );
    const inventory = buildDocumentationInventory({
      repoRoot: repo,
      files: ["docs/notes/example.md", "docs/adr/0001-example.md"],
    });
    const rendered = renderDocumentationIndex(inventory, {
      lastVerified: "2026-07-17",
    });
    assert.match(
      rendered,
      /\[`docs\/adr\/0001-example\.md`\]\(adr\/0001-example\.md\) — Example decision/,
    );
    assert.match(
      rendered,
      /\[`docs\/notes\/example\.md`\]\(notes\/example\.md\) \(archived\)(?! —)/,
    );
  });
});

test("render percent-encodes Markdown-sensitive document paths", () => {
  withRepo((repo) => {
    write(repo, "docs/plan (draft).md", "# Draft\n");
    const inventory = buildDocumentationInventory({
      repoRoot: repo,
      files: ["docs/plan (draft).md"],
    });
    const rendered = renderDocumentationIndex(inventory, {
      lastVerified: "2026-07-17",
    });
    assert.match(rendered, /\]\(plan%20%28draft%29\.md\)/);
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

test("prose-only edits do not change the tracked catalog", () => {
  withRepo((repo) => {
    const metadata =
      '<!-- agent-context: title="Root" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=reference scope=repo-wide review_interval_days=90 garden_lane=package-readmes-reference -->';
    write(repo, "README.md", `${metadata}\n\n# Root\n\nInitial prose.\n`);
    write(repo, "docs/context-standards.md", "# Context\n");
    track(repo, "README.md", "docs/context-standards.md");

    const written = run(repo, "--write");
    assert.equal(written.status, 0, written.stderr);
    const before = readFileSync(path.join(repo, "docs/README.md"), "utf8");

    write(
      repo,
      "README.md",
      `${metadata}\n\n# Root\n\nSubstantially different prose with many more words.\n`,
    );
    const checked = run(repo, "--check");
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(
      readFileSync(path.join(repo, "docs/README.md"), "utf8"),
      before,
    );
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
