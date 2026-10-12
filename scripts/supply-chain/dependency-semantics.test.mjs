import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGraph, checkGraph } from "./dependency-semantics.mjs";

// Reduced from PR #2570 discussion_r4248452598 / discussion_r4248452612.
// Preserve the importer -> Vitest -> Vite -> tsx and framework -> Express
// declaration edges; unrelated package metadata cannot affect these checks.
function fixtureText({
  node = "24.13.2",
  peer = "4.23.15",
  developmentNode = "26.6.1",
} = {}) {
  return `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      framework:
        specifier: 5.0.5
        version: 5.0.5
    devDependencies:
      '@types/node':
        specifier: 24.13.2
        version: 24.13.2
      tsx:
        specifier: ^4.23.15
        version: 4.23.15
      vitest:
        specifier: ^5.0.3
        version: 5.0.3(vite@8.0.16(tsx@${peer}))
      isolated-tool:
        specifier: 1.0.0
        version: 1.0.0
packages: {}
snapshots:
  framework@5.0.5:
    dependencies:
      '@types/express': 5.0.6
  '@types/express@5.0.6':
    dependencies:
      '@types/node': ${node}
  '@types/node@${node}': {}
  '@types/node@24.13.2': {}
${node === developmentNode ? "" : `  '@types/node@${developmentNode}': {}`}
  isolated-tool@1.0.0:
    dependencies:
      '@types/node': ${developmentNode}
  tsx@4.23.15: {}
  tsx@4.23.13: {}
  vitest@5.0.3(vite@8.0.16(tsx@${peer})):
    dependencies:
      vite: 8.0.16(tsx@${peer})
  vite@8.0.16(tsx@${peer}):
    optionalDependencies:
      tsx: ${peer}
  vite@7.0.0(tsx@4.23.13):
    optionalDependencies:
      tsx: 4.23.13
`.replaceAll(
    `  '@types/node@24.13.2': {}\n  '@types/node@24.13.2': {}`,
    "  '@types/node@24.13.2': {}",
  );
}

const fixture = (options) => readGraph(fixtureText(options));

test("corrected graph permits isolated tooling Node major and unreachable stale Vite", () => {
  assert.deepEqual(checkGraph(fixture(), ".", "24"), []);
});
test("PR2570 transitive Express Node26 edge fails although direct Node24 is pinned", () => {
  assert.match(
    checkGraph(fixture({ node: "26.6.1" }), ".", "24").join("\n"),
    /@types\/express@5.0.6 selects @types\/node 26.6.1/u,
  );
});
test("PR2570 stale reachable Vite tsx peer fails although CLI is upgraded", () => {
  assert.match(
    checkGraph(fixture({ peer: "4.23.13" }), ".", "24").join("\n"),
    /selects tsx 4.23.13, direct tsx is 4.23.15/u,
  );
});
test("same runtime major with a different patch is valid", () => {
  assert.deepEqual(checkGraph(fixture({ node: "24.14.0" }), ".", "24"), []);
});
test("runtime target changes invalidate old declarations", () => {
  assert.ok(checkGraph(fixture(), ".", "26").length > 0);
});
test("missing referenced snapshot is a blocker", () => {
  const graph = fixture();
  graph.snapshots.delete("@types/express@5.0.6");
  assert.throws(() => checkGraph(graph, ".", "24"), /missing graph target/u);
});
test("workspace links traverse runtime declarations without pulling isolated dev tooling", () => {
  const graph = fixture({ node: "26.6.1" });
  graph.importers.set("worker", graph.importers.get("."));
  graph.importers.set(".", {
    dependencies: { worker: "link:worker" },
    devDependencies: { "@types/node": "24.13.2" },
  });
  assert.match(checkGraph(graph, ".", "24").join("\n"), /26.6.1/u);
});
test("pnpm graph supports leading YAML metadata document", () => {
  const text =
    "lockfileVersion: '9.0'\n---\nimporters:\n  .: {}\nsnapshots:\n  app@1.0.0: {}\n";
  assert.ok(readGraph(text).importers.has("."));
});
test("future schemas and absent graphs fail closed", () => {
  assert.throws(() => readGraph("lockfileVersion: '10.0'"), /9.0 only/u);
  assert.throws(() => readGraph("lockfileVersion: '9.0'"), /missing importer/u);
});

function runEntry(options, standaloneOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "dependency-semantics-"));
  const application = "alerts/infra/oncall-announcer";
  try {
    mkdirSync(join(root, application), { recursive: true });
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      `packages:\n  - ${application}\n`,
    );
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, application, "package.json"), "{}");
    writeFileSync(
      join(root, application, "variables.tf"),
      'variable "runtime" {\n  default = "nodejs24"\n}\n',
    );
    writeFileSync(
      join(root, application, "main.tf"),
      'resource "google_cloudfunctions2_function" "test" {\n  build_config {\n    runtime = var.runtime\n  }\n}\n',
    );
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      fixtureText(standaloneOnly ? {} : options).replace(
        "  .:",
        `  ${application}:`,
      ),
    );
    writeFileSync(
      join(root, application, "pnpm-lock.yaml"),
      fixtureText(options),
    );
    return spawnSync(
      process.execPath,
      [new URL("./version-skew-check.mjs", import.meta.url).pathname],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SKEW_CHECK_ROOT: root },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("enforced skew entry checks graphs even with no catalog", () => {
  const result = runEntry({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /standalone/u);
  assert.match(result.stdout, /workspace/u);
});
test("enforced skew entry blocks root and standalone regressions", () => {
  for (const options of [{ node: "26.6.1" }, { peer: "4.23.13" }]) {
    for (const standaloneOnly of [true, false]) {
      const result = runEntry(options, standaloneOnly);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        standaloneOnly ? /standalone/u : /workspace/u,
      );
    }
  }
});
