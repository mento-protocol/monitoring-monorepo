import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  checkGuardrailProse,
  loadPins,
  normalizeProse,
  REMEDY,
  topLevelKeys,
} from "./check-guardrail-prose.mjs";

const CHECKER = fileURLToPath(
  new URL("./check-guardrail-prose.mjs", import.meta.url),
);

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The parent environment with the checker's own overrides stripped.
 *
 * Every spawn below either sets the root and pin path it wants or deliberately
 * exercises the defaults. Inheriting an ambient `GUARDRAIL_PROSE_ROOT` or
 * `GUARDRAIL_PROSE_PINS` — trivially present in a shell that just ran the
 * checker by hand — would silently redirect the default-environment cases at
 * another tree and fail this suite for a reason that has nothing to do with the
 * code under test. Sanitizing once here keeps every spawn on the same footing.
 */
const BASE_ENV = { ...process.env };
delete BASE_ENV.GUARDRAIL_PROSE_ROOT;
delete BASE_ENV.GUARDRAIL_PROSE_PINS;

const workspace = mkdtempSync(path.join(tmpdir(), "guardrail-prose-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

let fixtureCounter = 0;

const PINNED_SENTENCE =
  "**Never merge without explicit approval** for that specific merge.";

/**
 * A throwaway repository holding one pinned file and one pin file.
 *
 * `files` maps repo-relative paths to contents; `pins` is the pin object
 * verbatim, so a test can hand the checker a malformed one. `pinText` writes
 * the pin file byte for byte instead, which is the only way to express a shape
 * `JSON.stringify` cannot round-trip — a duplicated key.
 */
function newFixture({ files, pins, pinText }) {
  fixtureCounter += 1;
  const root = path.join(workspace, `fixture-${fixtureCounter}`);
  mkdirSync(root, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  const pinPath = path.join(root, "pins.json");
  writeFileSync(pinPath, pinText ?? `${JSON.stringify(pins, null, 2)}\n`);
  return { root, pinPath };
}

function runChecker({ root, pinPath }, args = []) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], {
    encoding: "utf8",
    env: {
      ...BASE_ENV,
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

test("a duplicated pin-list key fails closed instead of dropping a block", () => {
  // The fail-open this guards. `JSON.parse` keeps only the last "AGENTS.md"
  // block, so the absent sentence in the first block would never be looked for
  // and the run would exit 0 having checked one pin instead of two — with no
  // deletion anywhere in the diff to notice.
  const fixture = newFixture({
    files: { "AGENTS.md": `# Rules\n\n- ${PINNED_SENTENCE}\n` },
    pinText: [
      "{",
      '  "AGENTS.md": ["A sentence that appears nowhere in the file."],',
      `  "AGENTS.md": ${JSON.stringify([PINNED_SENTENCE])}`,
      "}",
      "",
    ].join("\n"),
  });
  const { status, output } = runChecker(fixture);
  assert.notEqual(status, 0, output);
  assert.match(output, /pin list itself is unusable/);
  assert.match(output, /AGENTS\.md is declared more than once/);
});

test("topLevelKeys reads the raw text without mistaking snippets for keys", () => {
  // The scanner has to consume whole string literals, or a snippet holding a
  // colon or a brace reads as a key and the duplicate check reports nonsense.
  const text = [
    "{",
    '  "AGENTS.md": ["a: b", "{\\"nested\\": 1}", "trailing brace }"],',
    '  "docs/notes/pr-operating-card.md": ["c"]',
    "}",
  ].join("\n");
  assert.deepEqual(topLevelKeys(text), [
    "AGENTS.md",
    "docs/notes/pr-operating-card.md",
  ]);
  assert.deepEqual(topLevelKeys('{"a":[1],"a":[2]}'), ["a", "a"]);
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
    env: { ...BASE_ENV, GUARDRAIL_PROSE_ROOT: empty },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENTS\.md: pinned file is missing/);

  // And against the real tree it passes, so the committed pins are current.
  const live = spawnSync(process.execPath, [CHECKER], {
    encoding: "utf8",
    env: BASE_ENV,
  });
  assert.equal(live.status, 0, `${live.stdout}${live.stderr}`);
});

test("root CLAUDE.md is pinned and still resolves to AGENTS.md", () => {
  // CLAUDE.md is the path the Claude runtime loads and is a symlink to
  // AGENTS.md, so `readFileSync` gives the pins the same bytes. That is what
  // makes the duplicated key block cheap — and what makes it worth having: the
  // day the link becomes a divergent regular file, the pins go on being checked
  // against the file agents actually read.
  const { pins, problems } = loadPins(
    path.join(REPO_ROOT, "scripts/repo-health/guardrail-prose.json"),
  );
  assert.deepEqual(problems, []);
  const pinned = new Map(pins);
  assert.ok(pinned.has("CLAUDE.md"), "CLAUDE.md must carry its own pin block");
  assert.deepEqual(
    pinned.get("CLAUDE.md"),
    pinned.get("AGENTS.md"),
    "the CLAUDE.md block must repeat the AGENTS.md snippets verbatim",
  );
  assert.equal(
    readlinkSync(path.join(REPO_ROOT, "CLAUDE.md")),
    "AGENTS.md",
    "CLAUDE.md is expected to be the AGENTS.md symlink",
  );
});

const CI_WORKFLOW = path.join(REPO_ROOT, ".github/workflows/ci.yml");
const GUARDRAIL_JOB = "guardrail-prose";
const GUARDRAIL_COMMANDS = [
  "node scripts/repo-health/check-guardrail-prose.mjs",
  "node scripts/repo-health/check-guardrail-prose.test.mjs",
];

/**
 * The body lines of one top-level workflow job, or null when it is absent.
 *
 * A bounded text scan rather than a YAML parse, because this suite runs inside
 * the very job it is checking and that job installs no dependencies, so
 * `js-yaml` is out of reach. Job keys sit at two spaces and everything within
 * them at four or more, so the next two-space key ends the block.
 */
function jobBody(workflow, jobId) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${jobId}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:/.test(lines[end])) {
    end += 1;
  }
  return lines.slice(start + 1, end);
}

/**
 * Every way the guardrail check could stop running without anyone noticing.
 *
 * The pins protect prose; nothing protected the job that reads them. A later
 * `ci.yml` edit could delete a step, gate the job behind a paths filter, or add
 * it to the sentinel's `allowed-skips`, and the required `ci` context would go
 * on reporting green over a check that no longer runs — the same silent-drop
 * failure the pins exist to prevent, one layer up.
 *
 * @returns {string[]} empty when the wiring is intact
 */
function guardrailWiringProblems(workflow) {
  const job = jobBody(workflow, GUARDRAIL_JOB);
  if (!job) return [`ci.yml defines no \`${GUARDRAIL_JOB}\` job`];

  const problems = [];
  if (job.some((line) => /^ {4}if:/.test(line))) {
    problems.push(
      `the \`${GUARDRAIL_JOB}\` job carries a job-level \`if:\`; a skipped required check counts as satisfied`,
    );
  }
  for (const command of GUARDRAIL_COMMANDS) {
    if (!job.some((line) => line.trim() === `run: ${command}`)) {
      problems.push(
        `the \`${GUARDRAIL_JOB}\` job no longer runs \`${command}\``,
      );
    }
  }

  const sentinel = jobBody(workflow, "ci");
  if (!sentinel) return [...problems, "ci.yml defines no `ci` sentinel job"];

  const needsAt = sentinel.findIndex((line) => /^ {4}needs:/.test(line));
  if (needsAt === -1) {
    problems.push("the `ci` sentinel declares no `needs:` list");
  } else {
    const closesAt = sentinel.findIndex(
      (line, at) => at > needsAt && line.includes("]"),
    );
    const needs = sentinel
      .slice(needsAt, closesAt === -1 ? sentinel.length : closesAt + 1)
      .join(" ");
    if (!new RegExp(`\\b${GUARDRAIL_JOB}\\b`).test(needs)) {
      problems.push(
        `the \`ci\` sentinel does not need \`${GUARDRAIL_JOB}\`, so the job cannot block a merge`,
      );
    }
  }

  const skipLine =
    sentinel.find((line) => line.includes("allowed-skips:")) ?? "";
  const skips = skipLine
    .slice(skipLine.indexOf(":") + 1)
    .split(",")
    .map((entry) => entry.trim());
  if (skips.includes(GUARDRAIL_JOB)) {
    problems.push(
      `\`${GUARDRAIL_JOB}\` sits in the \`ci\` sentinel's allowed-skips, which lets a skip read as success`,
    );
  }
  return problems;
}

test("the guardrail check is wired into CI where it cannot be skipped", () => {
  const problems = guardrailWiringProblems(readFileSync(CI_WORKFLOW, "utf8"));
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the wiring assertion reds on each way that wiring could rot", () => {
  // Negative controls. Each mutation is applied to the real ci.yml and asserted
  // to have changed it, so a rename that silently stops matching fails here
  // rather than leaving a control that proves nothing.
  const workflow = readFileSync(CI_WORKFLOW, "utf8");
  const mutations = [
    [
      "the job is renamed",
      (text) =>
        text.replace("\n  guardrail-prose:\n", "\n  moved-elsewhere:\n"),
      /defines no `guardrail-prose` job/,
    ],
    [
      "the job gains a paths filter",
      (text) =>
        text.replace(
          "  guardrail-prose:\n    name: Guardrail prose pins\n",
          "  guardrail-prose:\n    name: Guardrail prose pins\n    if: needs.changes.outputs.rootScripts == 'true'\n",
        ),
      /carries a job-level `if:`/,
    ],
    [
      "a run step is dropped",
      (text) =>
        text.replace(
          "      - name: Guardrail prose pin suite\n        run: node scripts/repo-health/check-guardrail-prose.test.mjs\n",
          "",
        ),
      /no longer runs `node scripts\/repo-health\/check-guardrail-prose\.test\.mjs`/,
    ],
    [
      "the sentinel stops needing it",
      (text) => text.replace("\n        guardrail-prose,", ""),
      /does not need `guardrail-prose`/,
    ],
    [
      "the sentinel is allowed to skip it",
      (text) =>
        text.replace(
          "allowed-skips: shared,",
          "allowed-skips: guardrail-prose,shared,",
        ),
      /allowed-skips/,
    ],
  ];

  for (const [label, mutate, expected] of mutations) {
    const mutated = mutate(workflow);
    assert.notEqual(
      mutated,
      workflow,
      `${label}: the mutation matched nothing, so this control proves nothing`,
    );
    const problems = guardrailWiringProblems(mutated);
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${label}: expected ${expected}, got ${JSON.stringify(problems)}`,
    );
  }
});
