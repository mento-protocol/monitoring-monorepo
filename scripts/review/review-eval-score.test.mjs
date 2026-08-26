#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  aggregateDraws,
  classifyNovel,
  extractClaims,
  JudgeOutputError,
  loadPrompt,
  matchClaims,
  mentionedLocations,
  parseJudgeJson,
  renderPrompt,
  runCalibration,
  SCORING_MODULES,
  scorerDigest,
  structuralCandidates,
  validateCalibrationSet,
} from "./review-eval-score.mjs";

const contract = JSON.parse(
  readFileSync(
    new URL("../../docs/evals/review-skill-fixtures.json", import.meta.url),
    "utf8",
  ),
);
const calibration = JSON.parse(
  readFileSync(
    new URL(
      "../../docs/evals/review-skill-judge-calibration.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

// One stub stands in for every model call. Nothing in this suite reaches a
// model, a network, or a CLI.
function stubExec(replies) {
  const queue = Array.isArray(replies) ? [...replies] : null;
  const calls = [];
  const exec = async (request) => {
    calls.push(request);
    if (queue) {
      if (queue.length === 0) throw new Error("stub exec ran out of replies");
      return queue.shift();
    }
    return replies(request, calls.length);
  };
  exec.calls = calls;
  return exec;
}

// `acted_on` mirrors the committed truth files: only an acted-on finding is a
// known defect for the novel judge. 103 is the finding the author never acted
// on, so a reviewer that raises it is novel, not a restatement.
const truthFindings = [
  {
    id: 101,
    path: "scripts/pr/pr-ready-state-core.mjs",
    line: 750,
    severity: "P1",
    title: "Split the growing ready-state core",
    body: "**bold** and <sub>markup</sub> around the real detail.",
    acted_on: true,
  },
  {
    id: 102,
    path: "terraform/alerts/peg.tf",
    line: 40,
    severity: "P2",
    title: "Alert threshold is inverted",
    body: "The threshold comparison is the wrong way round.",
    acted_on: true,
  },
  {
    id: 103,
    path: "ui-dashboard/app/page.tsx",
    line: 12,
    severity: "P2",
    title: "Unused import",
    body: "Import is never referenced.",
    acted_on: false,
  },
];

test("mentionedLocations keeps the Terraform extensions the original matcher missed", () => {
  const locations = mentionedLocations(
    "See terraform/alerts/peg.tf:41 and infra/main.hcl, plus config/app.toml " +
      "and terraform/tests/peg.tftest.hcl:9 with scripts/run.mjs:750.",
  );
  const files = locations.map((location) => location.file).sort();
  assert.deepEqual(files, [
    "app.toml",
    "main.hcl",
    "peg.tf",
    "peg.tftest.hcl",
    "run.mjs",
  ]);
  const peg = locations.find((location) => location.file === "peg.tf");
  assert.equal(peg.line, 41);
  assert.equal(
    locations.find((location) => location.file === "main.hcl").line,
    null,
  );
});

test("mentionedLocations ignores prose without a known extension", () => {
  assert.deepEqual(
    mentionedLocations("the readme and the Makefile look fine"),
    [],
  );
});

test("structuralCandidates proposes only findings whose file is named", () => {
  const candidates = structuralCandidates({
    truthFindings,
    output: "pr-ready-state-core.mjs:760 is wrong, and peg.tf reads oddly.",
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.finding.id),
    [101, 102],
  );
  assert.equal(
    candidates[0].lineNear,
    true,
    "760 is inside the 25-line window",
  );
  assert.equal(
    candidates[1].lineNear,
    false,
    "a bare file mention is not near",
  );
});

test("structuralCandidates drops a line hit outside the proximity window", () => {
  const [candidate] = structuralCandidates({
    truthFindings,
    output: "pr-ready-state-core.mjs:800 looks suspicious",
  });
  assert.equal(candidate.lineNear, false);
});

test("parseJudgeJson unwraps a CLI envelope and repairs fenced, comma-tailed JSON", () => {
  const envelope = JSON.stringify({
    result:
      '```json\n// best guess\n{"matches": [1, 2,],\n"reasoning": {}}\n```',
  });
  assert.deepEqual(parseJudgeJson(envelope).matches, [1, 2]);
});

test("parseJudgeJson throws JudgeOutputError rather than defaulting to empty", () => {
  assert.throws(
    () => parseJudgeJson("the judge apologises and explains itself in prose"),
    JudgeOutputError,
  );
  assert.throws(
    () => parseJudgeJson('{"matches": [1', { shape: "object" }),
    JudgeOutputError,
  );
});

test("renderPrompt refuses a template with an unfilled placeholder", () => {
  assert.throws(
    () => renderPrompt(loadPrompt("judge-match"), { DEFECTS: "1. x" }),
    /placeholder \{\{REVIEW\}\}/,
  );
});

test("extractClaims parses the claim array and caps its size", async () => {
  const exec = stubExec([JSON.stringify(["claim one", "claim two", "  "])]);
  const claims = await extractClaims({ transcript: "a review", exec });
  assert.deepEqual(claims, ["claim one", "claim two"]);
  assert.equal(exec.calls[0].model, "claude-opus-5");
  assert.match(exec.calls[0].prompt, /<review>\na review\n<\/review>/);
});

test("extractClaims truncates long claims and stops at twenty-five", async () => {
  const many = Array.from(
    { length: 30 },
    (_, index) => "x".repeat(700) + index,
  );
  const claims = await extractClaims({
    transcript: "review",
    exec: stubExec([JSON.stringify(many)]),
  });
  assert.equal(claims.length, 25);
  assert.equal(claims[0].length, 600);
});

test("extractClaims returns nothing for an empty transcript without calling the model", async () => {
  const exec = stubExec([]);
  assert.deepEqual(await extractClaims({ transcript: "   ", exec }), []);
  assert.equal(exec.calls.length, 0);
});

test("extractClaims throws when the splitter emits no array", async () => {
  await assert.rejects(
    extractClaims({
      transcript: "review",
      exec: stubExec(["I could not comply."]),
    }),
    JudgeOutputError,
  );
});

test("matchClaims maps judge numbers back to defect ids and keys reasoning by id", async () => {
  const exec = stubExec([
    JSON.stringify({
      matches: [2, 1, 2, 9],
      reasoning: {
        1: "names the same split",
        2: "same inverted threshold",
        7: "ignored",
      },
    }),
  ]);
  const result = await matchClaims({
    claims: ["a"],
    truthFindings,
    scorableIds: [101, 102, 103],
    transcript: "pr-ready-state-core.mjs:750 and peg.tf:40 are both wrong",
    exec,
  });
  assert.deepEqual(result.matchedIds, [101, 102]);
  assert.deepEqual(result.judgeReasoning, {
    101: "names the same split",
    102: "same inverted threshold",
  });
  assert.deepEqual(
    result.candidates.map((candidate) => [candidate.index, candidate.id]),
    [
      [1, 101],
      [2, 102],
    ],
  );
  assert.match(
    exec.calls[0].prompt,
    /1\. \[P1\] scripts\/pr\/pr-ready-state-core\.mjs:750/,
  );
  assert.match(
    exec.calls[0].prompt,
    /detail: bold and markup around the real detail\./,
  );
});

test("matchClaims falls back to the extracted claims when no transcript is given", async () => {
  const exec = stubExec([JSON.stringify({ matches: [1], reasoning: {} })]);
  const result = await matchClaims({
    claims: ["peg.tf:40 inverts the threshold"],
    truthFindings,
    scorableIds: [101, 102],
    exec,
  });
  assert.deepEqual(result.matchedIds, [102]);
});

test("matchClaims skips the judge when the structural pass proposes nothing", async () => {
  const exec = stubExec([]);
  const result = await matchClaims({
    claims: ["the change looks fine"],
    truthFindings,
    scorableIds: [101, 102],
    exec,
  });
  assert.deepEqual(result, {
    matchedIds: [],
    judgeReasoning: {},
    candidates: [],
  });
  assert.equal(exec.calls.length, 0);
});

test("matchClaims rejects a scorable id the truth file does not carry", async () => {
  await assert.rejects(
    matchClaims({
      claims: [],
      truthFindings,
      scorableIds: [101, 999],
      transcript: "pr-ready-state-core.mjs:750",
      exec: stubExec([]),
    }),
    /missing scorable ids: 999/,
  );
});

test("matchClaims poisons the cell when the judge output is unparsable", async () => {
  await assert.rejects(
    matchClaims({
      claims: [],
      truthFindings,
      scorableIds: [101],
      transcript: "pr-ready-state-core.mjs:750 is wrong",
      exec: stubExec(["sorry, no JSON today"]),
    }),
    JudgeOutputError,
  );
});

test("matchClaims poisons the cell when the reply carries no matches array", async () => {
  // A parseable object without `matches` is not "the review matched nothing":
  // scoring it as an empty set records every candidate as missed, which can
  // manufacture a regression flip or a RED verdict out of a malformed reply.
  for (const reply of [
    JSON.stringify({ reasoning: { 1: "no matches key at all" } }),
    JSON.stringify({ matches: "1", reasoning: {} }),
    JSON.stringify({ matches: { 1: true } }),
  ]) {
    await assert.rejects(
      matchClaims({
        claims: [],
        truthFindings,
        scorableIds: [101],
        transcript: "pr-ready-state-core.mjs:750 is wrong",
        exec: stubExec([reply]),
      }),
      (error) =>
        error instanceof JudgeOutputError &&
        /match judge returned no matches array/.test(error.message),
      reply,
    );
  }
  // An explicitly empty array is a result and still scores as zero matches.
  const empty = await matchClaims({
    claims: [],
    truthFindings,
    scorableIds: [101],
    transcript: "pr-ready-state-core.mjs:750 is wrong",
    exec: stubExec([JSON.stringify({ matches: [], reasoning: {} })]),
  });
  assert.deepEqual(empty.matchedIds, []);
});

test("matchClaims poisons the cell when the judge call itself fails", async () => {
  const exec = async () => {
    throw new Error("session limit reached");
  };
  await assert.rejects(
    matchClaims({
      claims: [],
      truthFindings,
      scorableIds: [101],
      transcript: "pr-ready-state-core.mjs:750 is wrong",
      exec,
    }),
    /session limit reached/,
  );
});

test("classifyNovel counts the four verdict classes", async () => {
  const exec = stubExec([
    JSON.stringify({
      verdicts: {
        1: { class: "real", why: "read the file" },
        2: { class: "wrong", why: "code does not do that" },
        3: { class: "vague", why: "style note" },
        4: { class: "known", why: "restates defect 101" },
      },
    }),
  ]);
  const result = await classifyNovel({
    claims: ["a", "b", "c", "d"],
    matchedIds: [101],
    truthFindings,
    fixturePath: "/tmp/fx-1990",
    exec,
  });
  assert.equal(result.novelReal, 1);
  assert.equal(result.novelWrong, 1);
  assert.equal(result.novelVague, 1);
  assert.equal(result.restatedKnown, 1);
  assert.equal(result.claims, 4);
  assert.equal(exec.calls[0].cwd, "/tmp/fx-1990");
  assert.match(exec.calls[0].prompt, /The repository is at \/tmp\/fx-1990\./);
  assert.match(
    exec.calls[0].prompt,
    /- terraform\/alerts\/peg\.tf:40 Alert threshold is inverted/,
  );
  // A finding the author never acted on is scored nowhere, so it must not be
  // offered to the judge as already known.
  assert.doesNotMatch(exec.calls[0].prompt, /Unused import/);
});

test("classifyNovel refuses a class outside the contract", async () => {
  // Bucketed as `unknownClass` this was dropped by the per-condition fold: the
  // claim counted as neither real nor wrong, so a judge that misspelled
  // `wrong` understated `wrong_claims` and could turn a RED run green with no
  // number anywhere recording that a verdict was missing.
  for (const off of ["maybe", "Wrong", "", null, "novel"]) {
    const exec = stubExec([
      JSON.stringify({
        verdicts: {
          1: { class: "real", why: "read the file" },
          2: { class: off, why: "off-contract class" },
        },
      }),
    ]);
    await assert.rejects(
      classifyNovel({
        claims: ["a", "b"],
        matchedIds: [101],
        truthFindings,
        fixturePath: "/tmp/fx-1990",
        exec,
      }),
      (error) => {
        assert.equal(error.name, "JudgeOutputError");
        assert.match(error.message, /outside real, wrong, vague, known/);
        return true;
      },
      `class ${JSON.stringify(off)} was scored instead of refused`,
    );
  }
});

test("classifyNovel refuses a verdict that is not an object", async () => {
  // The counter reads `verdict.class`. A bare string carrying a valid class
  // name passes any check that only looks at the class value, then folds as
  // `undefined` into no bucket at all: `novel_wrong` stays zero and a
  // hallucinated claim disappears past the wrong-claims RED ceiling.
  for (const scalar of ["wrong", "real", 3, true, ["wrong"]]) {
    const exec = stubExec([
      JSON.stringify({
        verdicts: {
          1: { class: "real", why: "read the file" },
          2: scalar,
        },
      }),
    ]);
    await assert.rejects(
      classifyNovel({
        claims: ["a", "b"],
        matchedIds: [101],
        truthFindings,
        fixturePath: "/tmp/fx-1990",
        exec,
      }),
      (error) => {
        assert.equal(error.name, "JudgeOutputError");
        assert.match(error.message, /non-object verdict/);
        return true;
      },
      `verdict ${JSON.stringify(scalar)} was scored instead of refused`,
    );
  }
});

test("classifyNovel short-circuits an empty claim list", async () => {
  const exec = stubExec([]);
  const result = await classifyNovel({ claims: [], truthFindings, exec });
  assert.equal(result.claims, 0);
  assert.equal(result.novelReal, 0);
  assert.equal(exec.calls.length, 0);
});

test("classifyNovel throws when the judge returns JSON without verdicts", async () => {
  await assert.rejects(
    classifyNovel({
      claims: ["a"],
      truthFindings,
      exec: stubExec([JSON.stringify({ notes: "none" })]),
    }),
    JudgeOutputError,
  );
});

test("classifyNovel refuses a verdict set that does not cover every claim", async () => {
  // A judge answering for a subset is the ordinary failure of a long reply.
  // Counting only what came back would report one classification for three
  // claims and leave `wrong_claims` — one of the two counters that can red a
  // row on its own — understated by the claims that fell out.
  await assert.rejects(
    classifyNovel({
      claims: ["a", "b", "c"],
      truthFindings,
      exec: stubExec([
        JSON.stringify({ verdicts: { 1: { class: "wrong", why: "checked" } } }),
      ]),
    }),
    (error) =>
      error instanceof JudgeOutputError && /missing 2, 3/.test(error.message),
  );
  // A verdict for a claim that was never sent is the same failure from the
  // other side: the reply is not about this claim list.
  await assert.rejects(
    classifyNovel({
      claims: ["a"],
      truthFindings,
      exec: stubExec([
        JSON.stringify({
          verdicts: {
            1: { class: "real", why: "checked" },
            2: { class: "wrong", why: "invented" },
          },
        }),
      ]),
    }),
    (error) =>
      error instanceof JudgeOutputError && /unexpected 2/.test(error.message),
  );
});

test("aggregateDraws folds draws into per-defect bit vectors", () => {
  const aggregate = aggregateDraws({
    scorableIds: [101, 102, 103],
    p1Ids: [101],
    draws: [{ matchedIds: [101, 102] }, { matchedIds: [101] }],
  });
  assert.deepEqual(aggregate.per_defect, {
    101: [1, 1],
    102: [1, 0],
    103: [0, 0],
  });
  assert.deepEqual(aggregate.recall, {
    matched: 3,
    opportunities: 6,
    rate: 0.5,
  });
  assert.deepEqual(aggregate.p1, { matched: 2, opportunities: 2, rate: 1 });
  assert.equal(aggregate.draws, 2);
});

test("aggregateDraws scores a defect only on the draws that covered it", () => {
  // 201 belongs to a PR that ran both draws; 301 to a PR that ran draw 1 only.
  const aggregate = aggregateDraws({
    scorableIds: [201, 301],
    p1Ids: [301],
    draws: [
      { matchedIds: [201, 301], scorableIds: [201, 301] },
      { matchedIds: [201], scorableIds: [201] },
    ],
  });
  assert.deepEqual(aggregate.per_defect, { 201: [1, 1], 301: [1] });
  assert.deepEqual(aggregate.recall, { matched: 3, opportunities: 3, rate: 1 });
  assert.deepEqual(aggregate.p1, { matched: 1, opportunities: 1, rate: 1 });
  assert.equal(aggregate.draws, 2);
});

test("aggregateDraws accepts bare id arrays and rejects an empty matrix", () => {
  const aggregate = aggregateDraws({ scorableIds: [101, 102], draws: [[102]] });
  assert.deepEqual(aggregate.per_defect, { 101: [0], 102: [1] });
  assert.deepEqual(aggregate.p1, { matched: 0, opportunities: 0, rate: null });
  assert.throws(
    () => aggregateDraws({ scorableIds: [101], draws: [] }),
    /at least one draw/,
  );
});

test("runCalibration counts agreement and names the disagreements", async () => {
  const set = {
    records: [
      {
        record_id: "a-matched",
        defect_id: 101,
        expected_verdict: "matched",
        claim_excerpt: "pr-ready-state-core.mjs:750 is past the size cap",
        defect: truthFindings[0],
      },
      {
        record_id: "b-unmatched",
        defect_id: 102,
        expected_verdict: "unmatched",
        claim_excerpt: "peg.tf could use a comment",
        defect: truthFindings[1],
      },
      {
        record_id: "c-matched",
        defect_id: 103,
        expected_verdict: "matched",
        claim_excerpt: "page.tsx:12 imports something unused",
        defect: truthFindings[2],
      },
    ],
  };
  const declines = ["could use a comment", "imports something unused"];
  const exec = stubExec((request) =>
    JSON.stringify({
      matches: declines.some((text) => request.prompt.includes(text))
        ? []
        : [1],
      reasoning: { 1: "stub" },
    }),
  );
  const result = await runCalibration({
    calibrationSet: set,
    exec,
    concurrency: 1,
  });
  assert.equal(result.total, 3);
  assert.equal(result.agreement, 2);
  assert.deepEqual(
    result.disagreements.map((row) => [
      row.record_id,
      row.expected,
      row.actual,
    ]),
    [["c-matched", "matched", "unmatched"]],
  );
  assert.equal(exec.calls.length, 3);
  assert.match(
    exec.calls[0].prompt,
    /1\. \[P1\] scripts\/pr\/pr-ready-state-core\.mjs:750/,
  );
});

test("runCalibration preserves record order under concurrency", async () => {
  const records = Array.from({ length: 8 }, (_, index) => ({
    record_id: `r${index}`,
    defect_id: 100 + index,
    expected_verdict: "matched",
    claim_excerpt: `claim ${index}`,
    defect: { ...truthFindings[0], id: 100 + index, title: `t${index}` },
  }));
  const exec = stubExec((request) =>
    JSON.stringify({
      matches: request.prompt.includes("t3") ? [] : [1],
      reasoning: {},
    }),
  );
  const result = await runCalibration({
    calibrationSet: records,
    exec,
    concurrency: 4,
  });
  assert.equal(result.agreement, 7);
  assert.deepEqual(
    result.disagreements.map((row) => row.record_id),
    ["r3"],
  );
});

test("runCalibration refuses an empty set", async () => {
  await assert.rejects(
    runCalibration({ calibrationSet: { records: [] }, exec: stubExec([]) }),
    /calibration set is empty/,
  );
});

test("the committed calibration set holds forty labelled pairs", () => {
  const { ok, problems } = validateCalibrationSet(calibration);
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
  assert.equal(calibration.counts.total, calibration.records.length);
  assert.equal(calibration.counts.matched, 20);
  assert.equal(calibration.counts.unmatched, 20);
});

test("validateCalibrationSet reports a set that lost its provenance or balance", () => {
  const broken = {
    ...calibration,
    provenance: "sampled from somewhere",
    records: calibration.records.slice(0, 39),
  };
  const { ok, problems } = validateCalibrationSet(broken);
  assert.equal(ok, false);
  assert.ok(problems.some((problem) => problem.includes("provenance")));
  assert.ok(problems.some((problem) => problem.includes("40 pairs")));
});

test("every calibration record points at a frozen scorable defect", () => {
  const scorableByPr = new Map(
    contract.fixtures.map((fixture) => [
      fixture.pr,
      new Set(fixture.scorable_ids),
    ]),
  );
  for (const record of calibration.records) {
    const scorable = scorableByPr.get(record.source_cell.pr);
    assert.ok(scorable, `PR ${record.source_cell.pr} is not in the contract`);
    assert.ok(
      scorable.has(record.defect_id),
      `${record.record_id} is not a frozen scorable defect`,
    );
  }
});

test("scorerDigest is a stable sha256 over the scorer and its prompts", () => {
  const digest = scorerDigest();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, scorerDigest());
});

test("scorerDigest covers every module that can move a recorded number", () => {
  // The per-condition fold, the recompute and the verdict rules live outside
  // this module, so an edit to one of them must break the pairing too. So do
  // the fixture helpers: `review-eval-fixtures.mjs` chooses the matrix, the
  // truth file and the recall denominator, and `build-fixture.sh` materializes
  // the checkout the contestant reviews and carries the checks that verify it.
  for (const name of [
    "review-eval-run.mjs",
    "review-eval-result-shape.mjs",
    "review-eval-report.mjs",
    "review-eval-fixtures.mjs",
    "build-fixture.sh",
  ]) {
    assert.ok(
      SCORING_MODULES.some((module) => module.endsWith(name)),
      `${name} is not hashed into the matcher digest`,
    );
  }
  assert.notEqual(
    scorerDigest({ modules: SCORING_MODULES.slice(1) }),
    scorerDigest(),
  );
});
