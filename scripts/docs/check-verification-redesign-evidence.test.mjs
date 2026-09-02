#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
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
  assert.throws(() => validateInventory(missing), /acyclic retained target/u);

  const self = fixtureRecords();
  self[5].duplicate_of = self[5].id;
  assert.throws(() => validateInventory(self), /acyclic retained target/u);

  const cycle = fixtureRecords();
  cycle[1].disposition = "duplicate";
  delete cycle[1].entry_point;
  cycle[1].duplicate_of = cycle[5].id;
  cycle[5].duplicate_of = cycle[1].id;
  assert.throws(() => validateInventory(cycle), /acyclic retained target/u);

  for (const terminalIndex of [6, 7]) {
    const nonRetained = fixtureRecords();
    nonRetained[2].disposition = "duplicate";
    delete nonRetained[2].entry_point;
    nonRetained[2].duplicate_of = nonRetained[terminalIndex].id;
    nonRetained[5].duplicate_of = nonRetained[2].id;
    assert.throws(
      () => validateInventory(nonRetained),
      /acyclic retained target/u,
    );
  }

  const scheduled = fixtureRecords();
  scheduled[2].disposition = "duplicate";
  delete scheduled[2].entry_point;
  scheduled[2].duplicate_of = scheduled[4].id;
  scheduled[5].duplicate_of = scheduled[2].id;
  assert.throws(() => validateInventory(scheduled), /acyclic retained target/u);
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
  const root = fs.mkdtempSync(join(tmpdir(), "verification-inventory-"));
  const inventoryPath = join(root, "inventory.jsonl");
  let output = "";
  try {
    fs.writeFileSync(
      inventoryPath,
      `${fixtureRecords().map(JSON.stringify).join("\n")}\n`,
    );
    runCli(["--check-inventory"], {
      inventoryPath,
      stdout: { write: (value) => (output += value) },
    });
    assert.equal(output, "OK: 7 structurally valid safeguard records.\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline summary matches the generated manifest totals", () => {
  const read = (name) =>
    JSON.parse(
      fs.readFileSync(
        new URL(`../../docs/metrics/${name}`, import.meta.url),
        "utf8",
      ),
    );
  const b = read("verification-redesign-baseline.json").local_gate;
  const m = read("verification-redesign-control-plane-before.json").totals;
  assert.equal(
    `${b.complete_manifest_files}:${b.complete_manifest_counted_lines}`,
    `${m.files}:${m.counted_lines}`,
  );
});

test("validateInventory rejects a missing id", () => {
  const records = fixtureRecords();
  delete records[1].id;
  assert.throws(() => validateInventory(records), /Safeguard needs id/u);
});

function withGitFixture(run) {
  const root = fs.mkdtempSync(join(tmpdir(), "verification-evidence-"));
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
      ".agents/roles/verifier.md": "Use --run.\n",
      ".agents/skills/backlog-sweep/SKILL.md":
        "git config agent.qualityGate.allowPackageScriptChanges true\nThe coordinator adopts run.lock.\nUse --allow-package-script-changes.\nUse --full-local-tests.\nUse --lock-wait.\nDo not use --no-lock.\nSet --command-timeout.\n",
      ".gitignore": ".terraform-agent-gate/\n.terraform-agent-gate\n",
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
        "      run: ./scripts/agent-quality-gate.sh --run --skip-if-fresh --pre-push --base origin/main",
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
      "scripts/agent-autoreview.sh":
        'my @gate_stat = lstat("$source_dir/gate");\nexit unless @gate_stat;\n',
      "scripts/check-agent-quality-gate-package-scripts.mjs":
        "export const packageScriptPins = true;\n",
      "scripts/gate/quality-gate-coordinator-startup-attestation.mjs":
        "export const startupAttestation = true;\n",
      "scripts/gate/quality-gate-coordinator.test.mjs":
        "export const coordinatorTest = true;\n",
      "scripts/pr/check-adr-reminder.mjs":
        "The gate uses --head.\nUse --changed-paths-file for the gate.\nUnrelated --head.\n",
      "scripts/review/review-eval.test.mjs":
        'const unrelatedLock = "run.lock";\n',
      "scripts/sentry/broker/gate-consumer.mjs": [
        'import "../../gate/mapped-command-process-identity.mjs";',
        'const variablePath = "$source_scripts_dir/gate/mapping.mjs";',
        'const variableDirectory = "$source_scripts_dir/gate: unavailable";',
        'const splitPath = ["gate", "mapped-command-process-identity.mjs"];',
        'const unrelatedKind = { kind: "gate", label: "review" };',
        'const sentryGate = ["scripts", "sentry", "gate", "manifest.json"];',
        "",
      ].join("\n"),
      "scripts/sentry/broker/sentry-mcp-probe.mjs":
        'const marker = inheritGateMarkerStdio;\nconst helper = "./mapped-command-process-identity.mjs";\nconst runtime = "darwin-process-identity-runtime.inc.c";\nconst lineage = "darwin-process-lineage.mjs";\nconst trunk = "trunk-check-once.test.sh";\nconst request = "agentqg:request";\nconst worker = "agentqg-worker";\nconst capacity = AGENT_QUALITY_GATE_CAPACITY;\nconst parallelism = AGENT_QUALITY_PARALLELISM;\nconst full = AGENT_GATE_FULL_TESTS;\nconst prewarm = AGENT_PREWARM_PARALLELISM;\nconst turbo = AGENT_TURBO_SHARED_CACHE;\nconst run = AGENTQG_RUN;\nconst suite = QUALITY_GATE_TEST_RUN;\nconst focus = GATE_TEST_FOCUS;\nconst portable = "portable-marker-v1";\nconst empty = "request-marker-empty-v1";\nconst coherent = "darwin-coherent-lineage-v2";\nconst unique = "darwin-unique-lineage-v1";\nconst owner = "coordinator-owner-v1";\n',
      "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-job.test.mjs":
        'const unrelated = GATE_JOB;\nconst direct = "scripts/agent-quality-gate.test.sh";\n',
      "scripts/sentry/gate/sentry-suite-gate-integrity.mjs":
        "const unrelated = GATE_LABEL;\n",
      "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-probe.mjs":
        'const continuation = "facts.mjs";\n',
      "package.json":
        '{\n  "scripts": {"agent:quality-gate": "./scripts/agent-quality-gate.sh"}\n}\n',
      "README.md": "Use the quality gate.\nUnrelated line.\n",
      "docs/adr/0007-agent-quality-gate-and-merge-oracle.md":
        "Gate decision.\nMerge oracle.\n",
      "docs/adr/0069-gate-routing-table-as-data.md":
        "Use lockfile-scope.mjs.\nUse arms-packages.mjs.\nUse pins.test.mjs.\nUse routing-table.test.mjs.\nUse engine.test.mjs.\nUse arms-scripts.mjs.\nUse arms-agent-modules.mjs.\n",
      "docs/adr/0076-fair-quality-gate-coordinator.md":
        "The coordinator owns run.lock.\nUse holder.reclaiming.quarantine.\nUse .holder-lsof-witness.\nUse owner.reclaiming.\nUse owner.claiming.\nUse owner.coordinator and owner.rollback.\nUse qgc-v1-u.\nUse coordinator.json.\nUse journal.json.\nUse requests/<requestId>.\nUse results/<executionId>.\nUse .deleting-v1.\nUse condemned.d.\nUse captured.<token>.\nUse <token>.draining.\nUse --command-not-started.\nUse --parallel.\n",
      "docs/evals/review-skill.md": "The review evaluator owns run.lock.\n",
      "docs/notes/agent-quality-gate-mechanics.md":
        'Use --run.\nUse --parallel.\nUse --fail-fast.\nUse --repo-root.\nUse --changed-paths-file.\nUse --real-tree.\nUse --base "$base_ref" --head "$head_ref".\nUse command-not-started.\nUse gate_lock_recover_hidden_record.\nUse gate_test_families.\nVitest related --run is unrelated.\nGeneric --base other is unrelated.\n--parallel-tests is unrelated.\ncommand-not-started-extra is unrelated.\n',
      "docs/pr-checklists/review-prompt-exclusions.md": "Use --run.\n",
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
      "ui-dashboard/scripts/arkham-smoke-test.mjs":
        'const dataQualityGate = "quality gate";\n',
      "indexer-envio/.cursor/rules/subgraph-migration.mdc":
        "This manual review is the final quality gate.\n",
      "unrelated.txt":
        "No control-plane text.\nThis equality gate is unrelated.\nagent.qualityGatekeeper is unrelated.\npins.test.mjs is unrelated here.\nportable-marker-v10 and coordinator-owner-v10 are unrelated.\nUse owner.claiming, owner.coordinator, and condemned.d outside the scoped documents.\nGeneric --run and --base flags are unrelated here.\n",
    };
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("buildManifest counts whole files and matching reference lines", () => {
  withGitFixture((repoRoot) => {
    const manifest = buildManifest({ repoRoot, source: "HEAD" });
    assert.deepEqual(
      manifest.entries.map(
        ({ path, count_mode, lines }) => `${path}|${count_mode}|${lines}`,
      ),
      [
        ".agents/roles/verifier.md|matching-lines|1",
        ".agents/skills/backlog-sweep/SKILL.md|matching-lines|7",
        ".github/workflows/ci.yml|matching-lines|2",
        ".gitignore|matching-lines|2",
        ".trunk/hooks/pre-push|whole-file|2",
        ".trunk/trunk.yaml|matching-lines|14",
        "README.md|matching-lines|1",
        "docs/adr/0007-agent-quality-gate-and-merge-oracle.md|whole-file|2",
        "docs/adr/0069-gate-routing-table-as-data.md|whole-file|7",
        "docs/adr/0076-fair-quality-gate-coordinator.md|whole-file|17",
        "docs/notes/agent-quality-gate-mechanics.md|whole-file|14",
        "docs/pr-checklists/review-prompt-exclusions.md|matching-lines|1",
        "package.json|matching-lines|1",
        "scripts/agent-autoreview.sh|matching-lines|2",
        "scripts/agent-quality-gate.sh|whole-file|2",
        "scripts/agent-quality-gate.test.sh|whole-file|2",
        "scripts/check-agent-quality-gate-package-scripts.mjs|whole-file|1",
        "scripts/gate/quality-gate-coordinator-startup-attestation.mjs|whole-file|1",
        "scripts/gate/quality-gate-coordinator.test.mjs|whole-file|1",
        "scripts/pr/check-adr-reminder.mjs|matching-lines|2",
        "scripts/sentry/broker/gate-consumer.mjs|matching-lines|4",
        "scripts/sentry/broker/sentry-mcp-probe.mjs|matching-lines|20",
        "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-job.test.mjs|matching-lines|1",
        "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-probe.mjs|matching-lines|1",
        "turbo.json|matching-lines|4",
      ],
    );
    assert.equal(manifest.totals.counted_lines, 112);
    assert.equal(
      manifest.entries.some(
        ({ path }) =>
          path.startsWith("scripts/review/") ||
          path.startsWith("ui-dashboard/") ||
          path.startsWith("indexer-envio/") ||
          path === "docs/evals/review-skill.md" ||
          path === "unrelated.txt",
      ),
      false,
    );
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
    assert.equal(
      manifest.entries.find(({ path }) => path.endsWith("gate-mechanics.md"))
        ?.surface,
      "instruction",
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

test("buildManifest accepts pre-push removal only with Trunk config", () => {
  withGitFixture((repoRoot) => {
    fs.rmSync(join(repoRoot, ".trunk/hooks/pre-push"));
    fs.writeFileSync(
      join(repoRoot, ".trunk/trunk.yaml"),
      [
        "actions:",
        "  disabled:",
        "    - trunk-announce",
        "  enabled:",
        "    - trunk-fmt-pre-commit",
        "    - trunk-upgrade-available",
        "",
      ].join("\n"),
    );
    execFileSync("git", ["-C", repoRoot, "add", "-A"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-qm", "remove pre-push"]);

    const manifest = buildManifest({ repoRoot, source: "HEAD" });
    assert.equal(
      manifest.entries.some(({ path }) => path.startsWith(".trunk/")),
      false,
    );
    fs.rmSync(join(repoRoot, ".trunk/trunk.yaml"));
    execFileSync("git", ["-C", repoRoot, "commit", "-qam", "remove config"]);
    assert.throws(
      () => buildManifest({ repoRoot, source: "HEAD" }),
      /Missing manifest path: \.trunk\/trunk\.yaml/u,
    );
  });
});

for (const [name, removeOneSide] of [
  [
    "buildManifest rejects a retained hook without the Trunk action",
    (repoRoot) =>
      fs.writeFileSync(
        join(repoRoot, ".trunk/trunk.yaml"),
        "actions:\n  enabled: []\n",
      ),
  ],
  [
    "buildManifest rejects a retained Trunk action without the hook",
    (repoRoot) => fs.rmSync(join(repoRoot, ".trunk/hooks/pre-push")),
  ],
]) {
  test(name, () => {
    withGitFixture((repoRoot) => {
      removeOneSide(repoRoot);
      execFileSync("git", ["-C", repoRoot, "add", "-A"]);
      execFileSync("git", ["-C", repoRoot, "commit", "-qm", name]);
      assert.throws(
        () => buildManifest({ repoRoot, source: "HEAD" }),
        /must be retained or removed together/u,
      );
    });
  });
}

test("buildManifest rejects partial pre-push removal", () => {
  withGitFixture((repoRoot) => {
    fs.writeFileSync(
      join(repoRoot, ".trunk/trunk.yaml"),
      [
        "actions:",
        "  definitions:",
        "    - id: agent-quality-gate-pre-push",
        "      triggers:",
        "        - git_hooks: [pre-push]",
        "",
      ].join("\n"),
    );
    execFileSync("git", ["-C", repoRoot, "add", ".trunk/trunk.yaml"]);
    execFileSync("git", [
      "-C",
      repoRoot,
      "commit",
      "-qm",
      "partially remove pre-push",
    ]);

    assert.throws(
      () => buildManifest({ repoRoot, source: "HEAD" }),
      /partially removed or malformed/u,
    );
  });
});

test("buildManifest rejects malformed pre-push run residue", () => {
  withGitFixture((repoRoot) => {
    fs.writeFileSync(
      join(repoRoot, ".trunk/trunk.yaml"),
      [
        "actions:",
        "  definitions:",
        "    - run: ./scripts/agent-quality-gate.sh --run --pre-push --base origin/main",
        "",
      ].join("\n"),
    );
    execFileSync("git", ["-C", repoRoot, "add", ".trunk/trunk.yaml"]);
    execFileSync("git", [
      "-C",
      repoRoot,
      "commit",
      "-qm",
      "leave malformed pre-push run",
    ]);

    assert.throws(
      () => buildManifest({ repoRoot, source: "HEAD" }),
      /partially removed or malformed/u,
    );
  });
});

test("buildManifest parses compact Turbo input filters", () => {
  withGitFixture((repoRoot) => {
    fs.writeFileSync(
      join(repoRoot, "turbo.json"),
      '{"tasks":{"fixture":{"inputs":["scripts/gate/**"]}}}\n',
    );
    execFileSync("git", ["-C", repoRoot, "add", "turbo.json"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-qm", "compact turbo"]);
    const manifest = buildManifest({ repoRoot, source: "HEAD" });
    assert.equal(
      manifest.entries.find(({ path }) => path === "turbo.json")?.lines,
      1,
    );
  });
});

test("buildManifest rejects a missing required whole-file path", () => {
  withGitFixture((repoRoot) => {
    fs.rmSync(
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
