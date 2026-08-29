#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  buildManifest,
  checkManifest,
  DISPOSITION_FIELDS,
  parseInventory,
  renderManifest,
  runCli,
  validateInventory,
} from "./check-verification-redesign-evidence.mjs";

function fixtureRecords() {
  const records = [
    {
      kind: "metadata",
      schema_version: 1,
      reviewed_at: "2026-08-28",
      baseline_source_sha: "a".repeat(40),
      owner: "eng",
      risk_classes: Array.from({ length: 13 }, (_, index) => index + 1),
    },
  ];
  const dispositions = [
    ["retained-required-ci", "entry_point"],
    ["retained-author-procedure", "entry_point"],
    ["retained-after-merge", "entry_point"],
    ["scheduled", "detection_interval"],
    ["duplicate", "duplicate_of"],
    ["obsolete-with-evidence", "evidence"],
    ["deferred-with-owner", "follow_up"],
  ];
  dispositions.forEach(([disposition, field], index) => {
    records.push({
      kind: "safeguard",
      id: `safeguard.${index}`,
      category: "fixture",
      name: `Safeguard ${index}`,
      sources: ["fixture"],
      risk_classes: index === 0 ? records[0].risk_classes : [1],
      owner: "eng",
      disposition,
      [field]: disposition === "duplicate" ? "safeguard.0" : "evidence",
    });
  });
  return records;
}

test("parseInventory accepts JSON Lines with a final newline", () => {
  const raw = `${fixtureRecords()
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;
  assert.equal(parseInventory(raw).length, 8);
});

test("parseInventory reports a malformed physical line after a blank", () => {
  const metadata = JSON.stringify(fixtureRecords()[0]);
  assert.throws(
    () => parseInventory(`${metadata}\n\n{\n`),
    /Inventory line 3 is not valid JSON/u,
  );
});

test("validateInventory accepts all seven complete dispositions", () => {
  const records = fixtureRecords();
  assert.deepEqual(validateInventory(records), {
    metadata: records[0],
    safeguard_count: 7,
  });
});

test("validateInventory rejects missing safeguard schema fields", () => {
  for (const field of [
    "category",
    "name",
    "sources",
    "risk_classes",
    "owner",
  ]) {
    const records = fixtureRecords();
    delete records[1][field];
    assert.throws(() => validateInventory(records), new RegExp(field, "u"));
  }
});

test("validateInventory rejects missing metadata schema fields", () => {
  for (const field of [
    "reviewed_at",
    "baseline_source_sha",
    "owner",
    "risk_classes",
  ]) {
    const records = fixtureRecords();
    delete records[0][field];
    assert.throws(() => validateInventory(records), new RegExp(field, "u"));
  }
  const coerced = fixtureRecords();
  coerced[0].baseline_source_sha = [coerced[0].baseline_source_sha];
  assert.throws(() => validateInventory(coerced), /full baseline_source_sha/u);
});

test("validateInventory rejects duplicate and unknown risk classes", () => {
  const duplicate = fixtureRecords();
  duplicate[1].risk_classes = [1, 1];
  assert.throws(() => validateInventory(duplicate), /duplicate or unknown/u);
  const unknown = fixtureRecords();
  unknown[1].risk_classes = [99];
  assert.throws(() => validateInventory(unknown), /duplicate or unknown/u);
});

test("validateInventory requires the fixed 13-class metadata schema", () => {
  const missing = fixtureRecords();
  missing[0].risk_classes.pop();
  assert.throws(
    () => validateInventory(missing),
    /exactly classes 1 through 13/u,
  );

  const extra = fixtureRecords();
  extra[0].risk_classes.push(14);
  assert.throws(() => validateInventory(extra), /duplicate or unknown/u);
});

test("validateInventory leaves safeguard risk coverage to review", () => {
  const records = fixtureRecords();
  for (const record of records.slice(1)) record.risk_classes = [1];
  assert.equal(validateInventory(records).safeguard_count, 7);
});

test("validateInventory rejects duplicate ids", () => {
  const records = fixtureRecords();
  records[2].id = records[1].id;
  assert.throws(() => validateInventory(records), /Duplicate safeguard id/u);
});

test("validateInventory rejects coerced disposition keys", () => {
  for (let index = 1; index < fixtureRecords().length; index += 1) {
    const records = fixtureRecords();
    records[index].disposition = [records[index].disposition];
    assert.throws(() => validateInventory(records), /invalid disposition/u);
  }

  const nested = fixtureRecords();
  nested[5].disposition = [["duplicate"]];
  nested[5].duplicate_of = "safeguard.missing";
  assert.throws(() => validateInventory(nested), /invalid disposition/u);

  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const records = fixtureRecords();
    records[1].disposition = name;
    records[1][{}[name]] = "evidence";
    assert.throws(() => validateInventory(records), /invalid disposition/u);
  }
});

test("validateInventory rejects invalid duplicate targets", () => {
  const missing = fixtureRecords();
  missing[5].duplicate_of = "safeguard.missing";
  assert.throws(
    () => validateInventory(missing),
    /existing acyclic retained target/u,
  );

  const self = fixtureRecords();
  self[5].duplicate_of = self[5].id;
  assert.throws(
    () => validateInventory(self),
    /existing acyclic retained target/u,
  );

  const cycle = fixtureRecords();
  cycle[1].disposition = "duplicate";
  delete cycle[1].entry_point;
  cycle[1].duplicate_of = cycle[5].id;
  cycle[5].duplicate_of = cycle[1].id;
  assert.throws(
    () => validateInventory(cycle),
    /existing acyclic retained target/u,
  );

  for (const terminalIndex of [6, 7]) {
    const nonRetained = fixtureRecords();
    nonRetained[2].disposition = "duplicate";
    delete nonRetained[2].entry_point;
    nonRetained[2].duplicate_of = nonRetained[terminalIndex].id;
    nonRetained[5].duplicate_of = nonRetained[2].id;
    assert.throws(
      () => validateInventory(nonRetained),
      /existing acyclic retained target/u,
    );
  }

  const scheduled = fixtureRecords();
  scheduled[2].disposition = "duplicate";
  delete scheduled[2].entry_point;
  scheduled[2].duplicate_of = scheduled[4].id;
  scheduled[5].duplicate_of = scheduled[2].id;
  assert.throws(
    () => validateInventory(scheduled),
    /existing acyclic retained target/u,
  );
});

test("validateInventory rejects a missing disposition evidence field", () => {
  const records = fixtureRecords();
  delete records.at(-1).follow_up;
  assert.throws(() => validateInventory(records), /needs follow_up/u);
});

test("validateInventory rejects incompatible disposition evidence fields", () => {
  const fields = [...new Set(Object.values(DISPOSITION_FIELDS))];
  for (let index = 1; index < fixtureRecords().length; index += 1) {
    for (const field of fields) {
      const records = fixtureRecords();
      if (field === DISPOSITION_FIELDS[records[index].disposition]) continue;
      records[index][field] = "incompatible";
      assert.throws(
        () => validateInventory(records),
        /incompatible disposition evidence/u,
      );
    }
  }
});

test("runCli reports structural inventory validation", () => {
  const root = mkdtempSync(join(tmpdir(), "verification-inventory-"));
  const inventoryPath = join(root, "inventory.jsonl");
  let output = "";
  try {
    writeFileSync(
      inventoryPath,
      `${fixtureRecords().map(JSON.stringify).join("\n")}\n`,
    );
    runCli(["--check-inventory"], {
      inventoryPath,
      stdout: { write: (value) => (output += value) },
    });
    assert.equal(output, "OK: 7 structurally valid safeguard records.\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateInventory rejects a missing id", () => {
  const records = fixtureRecords();
  delete records[1].id;
  assert.throws(() => validateInventory(records), /Safeguard needs id/u);
});

function withGitFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "verification-evidence-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "fixture@example.com",
    ]);
    execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
    const files = {
      ".trunk/hooks/pre-push":
        "#!/bin/sh\nexec trunk git-hooks callback pre-push\n",
      ".github/workflows/ci.yml": [
        "run: node --test scripts/gate/ci-no-legacy-source.test.mjs",
        "run: pnpm gate:routing-table:test",
        "",
      ].join("\n"),
      ".trunk/trunk.yaml": [
        "actions:",
        "  disabled:",
        "    - trunk-announce",
        "    - trunk-check-pre-push # Use custom pre-push below",
        "  definitions:",
        "    - id: agent-quality-gate-pre-push",
        "      display_name: Agent Quality Gate Pre-Push",
        "      description: >",
        "        Runs the path-aware agent quality gate before push. The gate maps the",
        "        branch diff to the required local checks instead of always running the",
        "        full monorepo pre-push suite.",
        "      run: ./scripts/agent-quality-gate.sh --run --skip-if-fresh",
        "      triggers:",
        "        - git_hooks: [pre-push]",
        "  enabled:",
        "    - trunk-fmt-pre-commit",
        "    - agent-quality-gate-pre-push",
        "    - trunk-upgrade-available",
        "",
      ].join("\n"),
      "scripts/agent-quality-gate.sh": "#!/bin/sh\necho gate\n",
      "scripts/agent-quality-gate.test.sh": "#!/bin/sh\necho gate test\n",
      "scripts/check-agent-quality-gate-package-scripts.mjs":
        "export const packageScriptPins = true;\n",
      "scripts/gate/quality-gate-coordinator-startup-attestation.mjs":
        "export const startupAttestation = true;\n",
      "scripts/gate/quality-gate-coordinator.test.mjs":
        "export const coordinatorTest = true;\n",
      "package.json":
        '{\n  "scripts": {"agent:quality-gate": "./scripts/agent-quality-gate.sh"}\n}\n',
      "README.md": "Use the quality gate.\nUnrelated line.\n",
      "turbo.json": [
        "{",
        '  "tasks": {',
        '    "fixture": {',
        '      "inputs": [',
        '        "package.json",',
        '        "$TURBO_ROOT$/scripts/gate/routing-table/**"',
        "      ]",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "unrelated.txt": "No control-plane text.\n",
    };
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("buildManifest counts whole files and matching reference lines", () => {
  withGitFixture((repoRoot) => {
    const manifest = buildManifest({ repoRoot, source: "HEAD" });
    assert.deepEqual(
      manifest.entries.map(({ path, count_mode, lines }) => ({
        path,
        count_mode,
        lines,
      })),
      [
        {
          path: ".github/workflows/ci.yml",
          count_mode: "matching-lines",
          lines: 2,
        },
        { path: ".trunk/hooks/pre-push", count_mode: "whole-file", lines: 2 },
        { path: ".trunk/trunk.yaml", count_mode: "matching-lines", lines: 14 },
        { path: "README.md", count_mode: "matching-lines", lines: 1 },
        { path: "package.json", count_mode: "matching-lines", lines: 1 },
        {
          path: "scripts/agent-quality-gate.sh",
          count_mode: "whole-file",
          lines: 2,
        },
        {
          path: "scripts/agent-quality-gate.test.sh",
          count_mode: "whole-file",
          lines: 2,
        },
        {
          path: "scripts/check-agent-quality-gate-package-scripts.mjs",
          count_mode: "whole-file",
          lines: 1,
        },
        {
          path: "scripts/gate/quality-gate-coordinator-startup-attestation.mjs",
          count_mode: "whole-file",
          lines: 1,
        },
        {
          path: "scripts/gate/quality-gate-coordinator.test.mjs",
          count_mode: "whole-file",
          lines: 1,
        },
        { path: "turbo.json", count_mode: "matching-lines", lines: 4 },
      ],
    );
    assert.equal(manifest.totals.counted_lines, 31);
    assert.equal(
      manifest.entries.find(({ path }) =>
        path.endsWith("startup-attestation.mjs"),
      )?.surface,
      "implementation",
    );
    assert.equal(
      manifest.entries.find(({ path }) => path.endsWith("coordinator.test.mjs"))
        ?.surface,
      "test",
    );
    checkManifest(
      buildManifest({ repoRoot, source: "HEAD" }),
      manifest,
      manifest.source_sha,
    );
    const rendered = renderManifest(manifest);
    assert.equal(rendered, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(renderManifest(JSON.parse(rendered)), rendered);
  });
});

test("buildManifest rejects a missing required whole-file path", () => {
  withGitFixture((repoRoot) => {
    rmSync(
      join(repoRoot, "scripts/check-agent-quality-gate-package-scripts.mjs"),
    );
    execFileSync("git", ["-C", repoRoot, "add", "-u"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-qm", "remove path"]);
    assert.throws(
      () => buildManifest({ repoRoot, source: "HEAD" }),
      /Missing manifest path/u,
    );
  });
});

test("checkManifest rejects changed evidence", () => {
  withGitFixture((repoRoot) => {
    const manifest = buildManifest({ repoRoot, source: "HEAD" });
    const changed = structuredClone(manifest);
    changed.totals.counted_lines += 1;
    assert.throws(
      () => checkManifest(manifest, changed, manifest.source_sha),
      /manifest is stale/u,
    );
  });
});

test("checkManifest rejects a source that differs from the inventory", () => {
  withGitFixture((repoRoot) => {
    const manifest = buildManifest({ repoRoot, source: "HEAD" });
    assert.throws(
      () => checkManifest(manifest, manifest, "b".repeat(40)),
      /manifest is stale/u,
    );
  });
});
