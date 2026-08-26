import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  checkGuardrailProse,
  loadPins,
  normalizeProse,
  REMEDY,
} from "./check-guardrail-prose.mjs";

const CHECKER = fileURLToPath(
  new URL("./check-guardrail-prose.mjs", import.meta.url),
);

const workspace = mkdtempSync(path.join(tmpdir(), "guardrail-prose-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

let fixtureCounter = 0;

const PINNED_SENTENCE =
  "**Never merge without explicit approval** for that specific merge.";

/**
 * A throwaway repository holding one pinned file and one pin file.
 *
 * `files` maps repo-relative paths to contents; `pins` is the pin object
 * verbatim, so a test can hand the checker a malformed one.
 */
function newFixture({ files, pins }) {
  fixtureCounter += 1;
  const root = path.join(workspace, `fixture-${fixtureCounter}`);
  mkdirSync(root, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  const pinPath = path.join(root, "pins.json");
  writeFileSync(pinPath, `${JSON.stringify(pins, null, 2)}\n`);
  return { root, pinPath };
}

function runChecker({ root, pinPath }, args = []) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDRAIL_PROSE_ROOT: root,
      GUARDRAIL_PROSE_PINS: pinPath,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("a present pinned sentence exits 0", () => {
  const fixture = newFixture({
    files: { "AGENTS.md": `# Rules\n\n- ${PINNED_SENTENCE}\n` },
    pins: { "AGENTS.md": [PINNED_SENTENCE] },
  });
  const { status, output } = runChecker(fixture);
  assert.equal(status, 0, output);
  assert.match(output, /1 pinned sentences present across 1 files/);
});

test("a removed pinned sentence exits nonzero, names it, and says how to fix it", () => {
  const fixture = newFixture({
    files: { "AGENTS.md": "# Rules\n\n- Something else entirely.\n" },
    pins: { "AGENTS.md": [PINNED_SENTENCE] },
  });
  const { status, output } = runChecker(fixture);
  assert.notEqual(status, 0);
  assert.match(output, /AGENTS\.md: missing snippet: /);
  assert.ok(
    output.includes(PINNED_SENTENCE),
    "the report must quote the snippet that went missing",
  );
  assert.ok(
    output.includes(REMEDY),
    "the report must tell the reader to restore the sentence or move the pin",
  );
});

test("a reflowed pinned sentence still passes", () => {
  // The same words, rewrapped across lines with list indentation — exactly what
  // a Prettier rewrap or a manual edit to the surrounding paragraph produces.
  const reflowed = [
    "# Rules",
    "",
    "- **Never merge without explicit approval** for",
    "  that specific",
    "  merge.",
    "",
  ].join("\n");
  const fixture = newFixture({
    files: { "AGENTS.md": reflowed },
    pins: { "AGENTS.md": [PINNED_SENTENCE] },
  });
  const { status, output } = runChecker(fixture);
  assert.equal(status, 0, output);
});

test("a pinned sentence written multi-line in the pin file also passes", () => {
  const fixture = newFixture({
    files: { "AGENTS.md": `# Rules\n\n- ${PINNED_SENTENCE}\n` },
    pins: {
      "AGENTS.md": [
        "**Never merge without explicit approval**\n   for that specific merge.",
      ],
    },
  });
  const { status, output } = runChecker(fixture);
  assert.equal(status, 0, output);
});

test("a missing pinned file exits nonzero and names the file", () => {
  const fixture = newFixture({
    files: { "AGENTS.md": `# Rules\n\n- ${PINNED_SENTENCE}\n` },
    pins: { "docs/notes/pr-operating-card.md": [PINNED_SENTENCE] },
  });
  const { status, output } = runChecker(fixture);
  assert.notEqual(status, 0);
  assert.match(
    output,
    /docs\/notes\/pr-operating-card\.md: pinned file is missing/,
  );
});

test("only the missing pin of several is reported", () => {
  const fixture = newFixture({
    files: { "AGENTS.md": `# Rules\n\n- ${PINNED_SENTENCE}\n` },
    pins: { "AGENTS.md": [PINNED_SENTENCE, "Secrets are IaC-owned."] },
  });
  const { status, output } = runChecker(fixture);
  assert.notEqual(status, 0);
  assert.match(output, /missing snippet: Secrets are IaC-owned\./);
  assert.equal(
    output.match(/missing snippet:/g).length,
    1,
    "the present pin must not be reported",
  );
});

test("an empty or malformed pin list fails closed rather than passing", () => {
  for (const pins of [{}, { "AGENTS.md": [] }, { "AGENTS.md": [""] }]) {
    const fixture = newFixture({
      files: { "AGENTS.md": `- ${PINNED_SENTENCE}\n` },
      pins,
    });
    const { status, output } = runChecker(fixture);
    assert.notEqual(
      status,
      0,
      `${JSON.stringify(pins)} must not read as "nothing to check": ${output}`,
    );
    assert.match(output, /pin list itself is unusable/);
  }
});

test("--help exits 0 and an unknown argument exits 1", () => {
  const fixture = newFixture({
    files: { "AGENTS.md": `- ${PINNED_SENTENCE}\n` },
    pins: { "AGENTS.md": [PINNED_SENTENCE] },
  });
  const help = runChecker(fixture, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.output, /GUARDRAIL_PROSE_PINS/);

  const unknown = runChecker(fixture, ["--bogus"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /Usage:/);
});

test("normalizeProse collapses whitespace runs and trims", () => {
  assert.equal(normalizeProse("  a\n\n  b\tc  "), "a b c");
});

test("loadPins rejects a non-object pin file", () => {
  const fixture = newFixture({ files: {}, pins: ["AGENTS.md"] });
  const { problems } = loadPins(fixture.pinPath);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must be an object mapping file paths/);
});

test("checkGuardrailProse reports findings without touching process state", () => {
  const fixture = newFixture({
    files: { "AGENTS.md": "# Rules\n" },
    pins: { "AGENTS.md": [PINNED_SENTENCE] },
  });
  const failures = checkGuardrailProse(fixture.root, [
    ["AGENTS.md", [PINNED_SENTENCE]],
  ]);
  assert.deepEqual(failures, [
    { file: "AGENTS.md", kind: "missing-snippet", detail: PINNED_SENTENCE },
  ]);
});

test("the committed pin list matches the repository it protects", () => {
  // The negative control for the live pin list: with the real pins loaded but
  // an empty repository underneath, every pinned file must be reported. If this
  // ever passes, the checker is not reading the committed pins at all.
  const empty = mkdtempSync(path.join(workspace, "empty-"));
  const result = spawnSync(process.execPath, [CHECKER], {
    encoding: "utf8",
    env: { ...process.env, GUARDRAIL_PROSE_ROOT: empty },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENTS\.md: pinned file is missing/);

  // And against the real tree it passes, so the committed pins are current.
  const live = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
  assert.equal(live.status, 0, `${live.stdout}${live.stderr}`);
});
