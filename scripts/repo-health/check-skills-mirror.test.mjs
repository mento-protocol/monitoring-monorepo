import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  compareMirrors,
  isForensicReportPath,
  normalizeProvenance,
} from "./check-skills-mirror.mjs";

const CHECKER = fileURLToPath(
  new URL("./check-skills-mirror.mjs", import.meta.url),
);

const workspace = mkdtempSync(path.join(tmpdir(), "skills-mirror-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

let fixtureCounter = 0;

/** A fresh identical pair of mirrored trees, one skill deep. */
function newFixture() {
  fixtureCounter += 1;
  const base = path.join(workspace, `fixture-${fixtureCounter}`);
  const rootA = path.join(base, "agents-skills");
  const rootB = path.join(base, "claude-skills");
  mkdirSync(path.join(rootA, "example-skill"), { recursive: true });
  mkdirSync(path.join(rootB, "example-skill"), { recursive: true });
  writeFileSync(path.join(rootA, "example-skill/SKILL.md"), "hello\n");
  writeFileSync(path.join(rootB, "example-skill/SKILL.md"), "hello\n");
  return { base, rootA, rootB };
}

function runChecker(rootA, rootB, args = []) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SKILLS_MIRROR_ROOT_A: rootA,
      SKILLS_MIRROR_ROOT_B: rootB,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

test("identical trees exit 0", () => {
  const { rootA, rootB } = newFixture();
  const { status, output } = runChecker(rootA, rootB);
  assert.equal(status, 0);
  assert.match(output, /are identical/);
});

test("content drift exits nonzero and names the differing file", () => {
  const { rootA, rootB } = newFixture();
  writeFileSync(path.join(rootB, "example-skill/SKILL.md"), "goodbye\n");
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /content drift: example-skill\/SKILL\.md/);
});

test("a file missing on one side exits nonzero and names it", () => {
  const { rootA, rootB } = newFixture();
  rmSync(path.join(rootB, "example-skill/SKILL.md"));
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /only in .*: example-skill\/SKILL\.md/);
});

test("an extra file on one side exits nonzero and names it", () => {
  const { rootA, rootB } = newFixture();
  writeFileSync(path.join(rootA, "example-skill/EXTRA.md"), "extra\n");
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /EXTRA\.md/);
});

test("a symlink exits nonzero even when it resolves to identical bytes", () => {
  const { rootA, rootB } = newFixture();
  const mirrored = path.join(rootB, "example-skill/SKILL.md");
  rmSync(mirrored);
  symlinkSync(path.join(rootA, "example-skill/SKILL.md"), mirrored);
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /symlink/);
});

test("a symlinked directory is reported rather than followed", () => {
  const { rootA, rootB } = newFixture();
  symlinkSync(
    path.join(rootA, "example-skill"),
    path.join(rootB, "linked-skill"),
  );
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /symlink/);
  assert.match(output, /linked-skill/);
});

test("a symlink used as a mirror root is rejected", () => {
  const { base, rootA, rootB } = newFixture();
  const realB = path.join(base, "claude-skills-real");
  renameSync(rootB, realB);
  symlinkSync(realB, rootB);
  // The trees are byte-identical through the link; the root symlink alone must
  // fail, or the check would validate content outside the declared tree.
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /symlink/);
  assert.match(output, /claude-skills/);
});

test("a dangling symlink root is reported as a missing directory", () => {
  const { base, rootA, rootB } = newFixture();
  rmSync(rootB, { recursive: true });
  symlinkSync(path.join(base, "nowhere"), rootB);
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /missing directory/);
});

test("the documented forensic-report provenance difference exits 0", () => {
  const { rootA, rootB } = newFixture();
  mkdirSync(path.join(rootA, "forensic-report"));
  mkdirSync(path.join(rootB, "forensic-report"));
  writeFileSync(
    path.join(rootA, "forensic-report/SKILL.md"),
    'writes source: "Codex" records\n',
  );
  writeFileSync(
    path.join(rootB, "forensic-report/SKILL.md"),
    'writes source: "claude" records\n',
  );
  const { status, output } = runChecker(rootA, rootB);
  assert.equal(status, 0, output);
});

test("any other difference in a forensic-report file still fails", () => {
  const { rootA, rootB } = newFixture();
  mkdirSync(path.join(rootA, "forensic-report"));
  mkdirSync(path.join(rootB, "forensic-report"));
  writeFileSync(
    path.join(rootA, "forensic-report/SKILL.md"),
    'writes source: "Codex" records\n',
  );
  writeFileSync(
    path.join(rootB, "forensic-report/SKILL.md"),
    'writes source: "claude" records, plus drift\n',
  );
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /beyond documented provenance/);
});

test("the provenance literal outside forensic-report is not exempt", () => {
  const { rootA, rootB } = newFixture();
  writeFileSync(
    path.join(rootA, "example-skill/SKILL.md"),
    'writes source: "Codex" records\n',
  );
  writeFileSync(
    path.join(rootB, "example-skill/SKILL.md"),
    'writes source: "claude" records\n',
  );
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /content drift: example-skill\/SKILL\.md/);
});

test("executable-bit drift exits nonzero and names the file", () => {
  const { rootA, rootB } = newFixture();
  chmodSync(path.join(rootA, "example-skill/SKILL.md"), 0o755);
  const { status, output } = runChecker(rootA, rootB);
  assert.notEqual(status, 0);
  assert.match(output, /executable-bit drift: example-skill\/SKILL\.md/);
});

test("a missing directory exits nonzero and says which", () => {
  const { base } = newFixture();
  const absent = path.join(base, "absent");
  const { status, output } = runChecker(absent, absent);
  assert.notEqual(status, 0);
  assert.match(output, /missing directory/);
});

test("--help exits 0 and an unknown argument exits 1", () => {
  const { rootA, rootB } = newFixture();
  const help = runChecker(rootA, rootB, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.output, /SKILLS_MIRROR_ROOT_A/);

  const unknown = runChecker(rootA, rootB, ["--bogus"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /Usage:/);
});

test("normalizeProvenance rewrites only the two documented literals", () => {
  assert.equal(
    normalizeProvenance('a source: "Codex" b source: "claude" c'),
    'a source: "__RUNTIME__" b source: "__RUNTIME__" c',
  );
  assert.equal(
    normalizeProvenance('source: "Gemini"'),
    'source: "Gemini"',
    "an undocumented runtime literal must stay a real difference",
  );
});

test("isForensicReportPath matches only forensic-report skill files", () => {
  assert.equal(isForensicReportPath("forensic-report/SKILL.md"), true);
  assert.equal(isForensicReportPath("nested/forensic-report/SKILL.md"), true);
  assert.equal(isForensicReportPath("forensic-report-notes/SKILL.md"), false);
  assert.equal(isForensicReportPath("example-skill/SKILL.md"), false);
});

test("compareMirrors reports drift without touching process state", () => {
  const { rootA, rootB } = newFixture();
  writeFileSync(path.join(rootA, "example-skill/ONLY-A.md"), "a\n");
  writeFileSync(path.join(rootB, "example-skill/ONLY-B.md"), "b\n");
  const { fatal, drift } = compareMirrors(rootA, rootB);
  assert.deepEqual(fatal, []);
  assert.deepEqual(drift, [
    `only in ${rootA}: example-skill/ONLY-A.md`,
    `only in ${rootB}: example-skill/ONLY-B.md`,
  ]);
});
