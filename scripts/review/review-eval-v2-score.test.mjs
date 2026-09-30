import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  FINAL_REVIEW_CONTRACT,
  scoreReview,
  scorerDigestV2,
} from "./review-eval-v2-score.mjs";

const review = (finalText) => ({
  finalText,
  completed: true,
  outputContract: FINAL_REVIEW_CONTRACT,
});
const root = {
  id: "root-1",
  title: "Unvalidated value",
  locations: [{ path: "Token.sol" }],
  trigger: "null input",
  mechanism: "dereference",
  consequence: "crash",
};
const claim = (text) => ({ text, quote: text });
const extraction = (...claims) => ({ complete: true, claims });
const match = (overrides = {}) => ({
  id: root.id,
  verdict: "matched",
  claim_ids: ["c1"],
  quote: "The null input crashes.",
  reason: "Same null dereference.",
  ...overrides,
});
const unmatched = (id = root.id) =>
  match({ id, verdict: "unmatched", claim_ids: [], quote: "" });

function judgeSequence(replies, requests = []) {
  let index = 0;
  return {
    model: "stub-judge",
    effort: "high",
    exec: async (request) => {
      requests.push(request);
      assert.ok(index < replies.length, "unexpected paid-call substitute");
      const response = replies[index++];
      if (response instanceof Error) throw response;
      return typeof response === "string" ? response : JSON.stringify(response);
    },
  };
}

test("only the consolidated final report is scored, including cleared suspicions", async () => {
  const requests = [];
  const result = await scoreReview({
    review: {
      ...review("No findings. The earlier null suspicion is cleared."),
      transcript: "The null input crashes.",
    },
    defects: [root],
    judge: judgeSequence([extraction()], requests),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.defects[0].verdict, "unmatched");
  assert.deepEqual(result.claims, []);
  assert.equal(requests.length, 1);
  assert.ok(!requests[0].prompt.includes("The null input crashes."));
  assert.deepEqual(requests[0].allowedTools, []);
  assert.equal(result.calibration.expert_validated, false);
});

test("a negative control with no claims completes without match or novelty calls", async () => {
  const result = await scoreReview({
    review: review("No findings."),
    defects: [],
    judge: judgeSequence([extraction()]),
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.defects, []);
  assert.deepEqual(result.novel, []);
});

test("every root reaches the matcher regardless of path or review location", async () => {
  const requests = [];
  const defects = [
    root,
    { ...root, id: "docker", locations: [{ path: "Dockerfile" }] },
  ];
  const result = await scoreReview({
    review: review("The null input crashes."),
    defects,
    judge: judgeSequence(
      [
        extraction(claim("The null input crashes.")),
        { defects: [match(), unmatched("docker")] },
      ],
      requests,
    ),
  });
  assert.equal(result.status, "complete");
  assert.ok(requests[1].prompt.includes("Token.sol"));
  assert.ok(requests[1].prompt.includes("Dockerfile"));
  assert.equal(result.defects[0].verdict, "matched");
});

test("26 claims and long claims survive without truncation", async () => {
  const texts = Array.from(
    { length: 26 },
    (_, index) =>
      `Claim ${index}: ${"mechanism ".repeat(80)}consequence ${index}`,
  );
  const requests = [];
  const result = await scoreReview({
    review: review(texts.join("\n")),
    defects: [],
    fixturePath: "/unused",
    sourceDiff: "complete working-tree diff",
    judge: judgeSequence(
      [
        extraction(...texts.map(claim)),
        {
          novel: texts.map((_, index) => ({
            claim_id: `c${index + 1}`,
            verdict: "unsupported",
            reason: "No verifiable trigger.",
          })),
        },
      ],
      requests,
    ),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.claims.length, 26);
  assert.equal(result.novel.length, 26);
  assert.equal(result.claims[25].text, texts[25]);
  assert.ok(requests[1].prompt.includes(texts[25]));
  assert.ok(requests[1].prompt.includes("complete working-tree diff"));
  assert.deepEqual(requests[1].allowedTools, ["Read", "Grep", "Glob"]);
});

test("novel classification requires the complete diff and never silently drops an oversized diff", async () => {
  for (const sourceDiff of [undefined, "x".repeat(120_001)]) {
    const result = await scoreReview({
      review: review("This crashes."),
      defects: [],
      fixturePath: "/unused",
      sourceDiff,
      judge: judgeSequence([extraction(claim("This crashes."))]),
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.coverage.classification, "incomplete");
    assert.match(
      result.errors[0].message,
      /complete working-tree diff|no text was truncated/,
    );
  }
});

test("oversized input is explicitly incomplete before a model call", async () => {
  const result = await scoreReview({
    review: review("x".repeat(300)),
    defects: [],
    maxInputChars: 100,
    judge: judgeSequence([]),
  });
  assert.equal(result.status, "incomplete");
  assert.match(result.errors[0].message, /no text was truncated/);
});

test("missing final contract and empty final text fail before calls", async () => {
  for (const input of [{ finalText: "No findings." }, review("")]) {
    const result = await scoreReview({
      review: input,
      defects: [],
      judge: judgeSequence([]),
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.errors.length, 1);
  }
});

test("extraction rejects invented quotes and explicit incomplete coverage", async () => {
  for (const response of [
    extraction({ text: "fake", quote: "fake" }),
    { complete: false, claims: [] },
  ]) {
    const result = await scoreReview({
      review: review("The null input crashes."),
      defects: [root],
      judge: judgeSequence([response]),
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.coverage.extraction, "incomplete");
  }
});

test("exact duplicate claims fail extraction before IDs or later grading", async () => {
  for (const defects of [[root], []]) {
    const requests = [];
    const result = await scoreReview({
      review: review("The null input crashes."),
      defects,
      fixturePath: "/unused",
      sourceDiff: "complete working-tree diff",
      judge: judgeSequence(
        [
          extraction(
            claim("The null input crashes."),
            claim("The null input crashes."),
          ),
          defects.length
            ? { defects: [match({ claim_ids: ["c1", "c2"] })] }
            : {
                novel: ["c1", "c2"].map((claim_id) => ({
                  claim_id,
                  verdict: "unsupported",
                  reason: "No verifiable trigger.",
                })),
              },
        ],
        requests,
      ),
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.coverage.extraction, "incomplete");
    assert.match(result.errors[0].message, /duplicate claims/);
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.defects, []);
    assert.deepEqual(result.novel, []);
    assert.equal(
      requests.length,
      1,
      "duplicates must not reach matching or novelty",
    );
  }
});

test("distinct claims can share one supporting quote", async () => {
  const quote = "Null input crashes, and an empty list hangs.";
  const result = await scoreReview({
    review: review(quote),
    defects: [],
    fixturePath: "/unused",
    sourceDiff: "complete working-tree diff",
    judge: judgeSequence([
      extraction(
        { text: "Null input crashes.", quote },
        { text: "An empty list hangs.", quote },
      ),
      {
        novel: ["c1", "c2"].map((claim_id) => ({
          claim_id,
          verdict: "unsupported",
          reason: "No verifiable trigger.",
        })),
      },
    ]),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.claims.length, 2);
  assert.deepEqual(
    result.claims.map((claim) => claim.id),
    ["c1", "c2"],
  );
});

test("matcher rejects omitted roots, duplicates, unknown IDs, and fabricated quotes", async () => {
  const invalid = [
    [],
    [match(), match()],
    [match({ id: "unknown" })],
    [match({ quote: "fabricated" })],
    [match({ claim_ids: ["c99"] })],
    [match({ claim_ids: ["c1", "c1"] })],
    [match({ claim_ids: [] })],
    [match({ verdict: "unmatched" })],
  ];
  for (const defects of invalid) {
    const result = await scoreReview({
      review: review("The null input crashes."),
      defects: [root],
      judge: judgeSequence([
        extraction(claim("The null input crashes.")),
        { defects },
      ]),
    });
    assert.equal(result.status, "incomplete", JSON.stringify(defects));
    assert.equal(result.coverage.matching, "incomplete");
  }
});

test("uncertain matches and unverified claims remain visible without becoming misses or false alarms", async () => {
  const result = await scoreReview({
    review: review("The null input crashes."),
    defects: [root],
    fixturePath: "/unused",
    sourceDiff: "complete working-tree diff",
    judge: judgeSequence([
      extraction(claim("The null input crashes.")),
      {
        defects: [
          match({
            verdict: "uncertain",
            quote: "",
            reason: "Trigger is ambiguous.",
          }),
        ],
      },
      {
        novel: [
          {
            claim_id: "c1",
            verdict: "unverified",
            reason: "External behavior unavailable.",
          },
        ],
      },
    ]),
  });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.errors, []);
  assert.equal(result.defects[0].verdict, "uncertain");
  assert.equal(result.novel[0].verdict, "unverified");
});

test("same-file claims can be unmatched and get source-backed classification", async (context) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "v2-score-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(
    path.join(fixture, "Token.sol"),
    "if (input == null) return;\n",
  );
  for (const verdict of ["wrong", "model-supported"]) {
    const result = await scoreReview({
      review: review("Token.sol loses the caller's value."),
      defects: [root],
      fixturePath: fixture,
      sourceDiff: "complete working-tree diff",
      judge: judgeSequence([
        extraction(claim("Token.sol loses the caller's value.")),
        { defects: [unmatched()] },
        {
          novel: [
            {
              claim_id: "c1",
              verdict,
              reason: "Checked the changed guard.",
              evidence: [
                { path: "Token.sol", quote: "if (input == null) return;" },
              ],
            },
          ],
        },
      ]),
    });
    assert.equal(result.status, "complete");
    assert.equal(result.defects[0].verdict, "unmatched");
    assert.equal(result.novel[0].verdict, verdict);
  }
});

test("novel classifications require all claims, known labels, and real source quotes", async (context) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "v2-score-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(path.join(fixture, "source"), "real code");
  const invalid = [
    [],
    [{ claim_id: "c99", verdict: "unsupported", reason: "unknown" }],
    [{ claim_id: "c1", verdict: "human-confirmed", reason: "invented" }],
    [{ claim_id: "c1", verdict: "wrong", reason: "no evidence" }],
    [
      {
        claim_id: "c1",
        verdict: "wrong",
        reason: "bad quote",
        evidence: [{ path: "source", quote: "invented code" }],
      },
    ],
  ];
  for (const novel of invalid) {
    const result = await scoreReview({
      review: review("This crashes."),
      defects: [],
      fixturePath: fixture,
      sourceDiff: "complete working-tree diff",
      judge: judgeSequence([extraction(claim("This crashes.")), { novel }]),
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.coverage.classification, "incomplete");
  }
});

test("source evidence cannot escape through paths or symlinks", async (context) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "v2-evidence-"));
  const fixture = mkdtempSync(path.join(rootDir, "fixture-"));
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "outside"), "answer key");
  symlinkSync(path.join(rootDir, "outside"), path.join(fixture, "link"));
  for (const source of ["../outside", "link"]) {
    const result = await scoreReview({
      review: review("This crashes."),
      defects: [],
      fixturePath: fixture,
      sourceDiff: "complete working-tree diff",
      judge: judgeSequence([
        extraction(claim("This crashes.")),
        {
          novel: [
            {
              claim_id: "c1",
              verdict: "wrong",
              reason: "outside evidence",
              evidence: [{ path: source, quote: "answer key" }],
            },
          ],
        },
      ]),
    });
    assert.match(result.errors[0].message, /escapes the fixture/);
  }
});

test("provider failure and malformed output are incomplete instead of no findings", async () => {
  for (const reply of [
    new Error("quota"),
    "not JSON",
    { is_error: true, result: JSON.stringify(extraction()) },
  ]) {
    const result = await scoreReview({
      review: review("No findings."),
      defects: [],
      judge: judgeSequence([reply]),
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.errors.length, 1);
  }
});

test("scorer identity is stable and contains a full sha256 digest", () => {
  assert.match(scorerDigestV2(), /^[a-f0-9]{64}$/);
  assert.equal(scorerDigestV2(), scorerDigestV2());
});

async function copiedScorer(context) {
  const copy = mkdtempSync(path.join(os.tmpdir(), "v2-scorer-identity-"));
  context.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const file of [
    "review-eval-v2-score.mjs",
    "review-eval-score.mjs",
    "review-eval-stream.mjs",
    "review-eval-v2-selection.mjs",
    "review-eval-v2-report.mjs",
    "prompts/v2",
  ]) {
    cpSync(new URL(file, import.meta.url), path.join(copy, file), {
      recursive: true,
    });
  }
  const scorer = await import(
    pathToFileURL(path.join(copy, "review-eval-v2-score.mjs"))
  );
  return { copy, scorer };
}

test("scorer identity changes when answer-key selection behavior changes", async (context) => {
  const { copy, scorer } = await copiedScorer(context);
  const selectorPath = path.join(copy, "review-eval-v2-selection.mjs");
  const selectorUrl = pathToFileURL(selectorPath).href;
  const beforeSelector = await import(selectorUrl);
  const dataset = {
    cases: [
      {
        id: "repaired",
        expected_root_ids: [],
        negative_control_root_ids: ["root"],
      },
    ],
    roots: [{ id: "root" }],
  };
  assert.deepEqual(
    beforeSelector.rootsForCase(dataset, "repaired"),
    dataset.roots,
  );
  const beforeDigest = scorer.scorerDigestV2();
  const beforeSource = readFileSync(selectorPath, "utf8");
  const afterSource = beforeSource.replace(
    "...item.negative_control_root_ids,",
    "",
  );
  assert.notEqual(
    afterSource,
    beforeSource,
    "fault injection must change selector",
  );
  writeFileSync(selectorPath, afterSource);
  assert.deepEqual(
    beforeSelector.rootsForCase(dataset, "repaired"),
    dataset.roots,
    "the loaded selector still has the previous behavior",
  );
  assert.throws(
    () => scorer.scorerDigestV2(),
    /source changed after module load/,
  );
  const fresh = freshScorer(
    copy,
    `({
    digest: scorer.scorerDigestV2(),
    roots: (await import("./review-eval-v2-selection.mjs")).rootsForCase(${JSON.stringify(dataset)}, "repaired"),
  })`,
  );
  assert.deepEqual(fresh.roots, []);
  assert.notEqual(
    fresh.digest,
    beforeDigest,
    "a fresh selector must use a new scoring identity",
  );
});

test("scorer identity changes when report reduction changes", async (context) => {
  const { copy, scorer } = await copiedScorer(context);
  const reducerPath = path.join(copy, "review-eval-v2-report.mjs");
  const reducerUrl = pathToFileURL(reducerPath).href;
  const beforeReducer = await import(reducerUrl);
  assert.equal(beforeReducer.metricSummary([]).arms.incumbent.known_matched, 0);
  const beforeDigest = scorer.scorerDigestV2();
  const beforeSource = readFileSync(reducerPath, "utf8");
  const afterSource = beforeSource.replace(
    "known_matched: matched,",
    "known_matched: matched + 1,",
  );
  assert.notEqual(
    afterSource,
    beforeSource,
    "fault injection must change the report reducer",
  );
  writeFileSync(reducerPath, afterSource);
  assert.equal(
    beforeReducer.metricSummary([]).arms.incumbent.known_matched,
    0,
    "the loaded reducer still has the previous behavior",
  );
  assert.throws(
    () => scorer.scorerDigestV2(),
    /source changed after module load/,
  );
  const fresh = freshScorer(
    copy,
    `({
    digest: scorer.scorerDigestV2(),
    matched: (await import("./review-eval-v2-report.mjs")).metricSummary([]).arms.incumbent.known_matched,
  })`,
  );
  assert.equal(fresh.matched, 1);
  assert.notEqual(
    fresh.digest,
    beforeDigest,
    "a fresh reducer must use a new scoring identity",
  );
});

function freshScorer(copy, expression) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
    import * as scorer from "./review-eval-v2-score.mjs";
    console.log(JSON.stringify(${expression}));
  `,
      ],
      { cwd: copy, env: {}, encoding: "utf8" },
    ),
  );
}

test("loaded scorer rejects changed source while a fresh process can rescore it", async (context) => {
  const { copy, scorer } = await copiedScorer(context);
  const beforeDigest = scorer.scorerDigestV2();
  const sourcePath = path.join(copy, "review-eval-v2-score.mjs");
  const source = readFileSync(sourcePath, "utf8");
  const changed = source.replace(
    '"final-consolidated-v1"',
    '"test-fresh-contract"',
  );
  assert.notEqual(changed, source);
  writeFileSync(sourcePath, changed);
  assert.equal(
    scorer.FINAL_REVIEW_CONTRACT,
    "final-consolidated-v1",
    "the existing ESM instance still exposes its loaded contract",
  );
  assert.throws(
    () => scorer.scorerDigestV2(),
    /source changed after module load/,
  );
  const fresh = freshScorer(
    copy,
    `({
    digest: scorer.scorerDigestV2(),
    contract: scorer.FINAL_REVIEW_CONTRACT,
    result: await scorer.scoreReview({
      review: { finalText: "No findings.", completed: true, outputContract: scorer.FINAL_REVIEW_CONTRACT },
      defects: [],
      judge: {model: "stub", effort: "high", exec: async () => '{"complete":true,"claims":[]}'},
    }),
  })`,
  );
  assert.notEqual(fresh.digest, beforeDigest);
  assert.equal(fresh.contract, "test-fresh-contract");
  assert.equal(fresh.result.status, "complete");
});

test("direct scoring rejects prompt drift before invoking a judge", async (context) => {
  const { copy, scorer } = await copiedScorer(context);
  const prompt = path.join(copy, "prompts/v2/extract-claims.md");
  writeFileSync(prompt, `${readFileSync(prompt, "utf8")}\nchanged rubric\n`);
  const requests = [];
  const result = await scorer.scoreReview({
    review: review("No findings."),
    defects: [],
    judge: judgeSequence([extraction()], requests),
  });
  assert.equal(result.status, "incomplete");
  assert.match(result.errors[0].message, /source changed after module load/);
  assert.equal(requests.length, 0);
});

test("source drift during the final judge await invalidates the result", async (context) => {
  const { copy, scorer } = await copiedScorer(context);
  const reducer = path.join(copy, "review-eval-v2-report.mjs");
  let calls = 0;
  const result = await scorer.scoreReview({
    review: review("No findings."),
    defects: [],
    judge: {
      model: "stub",
      effort: "high",
      exec: async () => {
        calls++;
        await Promise.resolve();
        writeFileSync(
          reducer,
          `${readFileSync(reducer, "utf8")}\n// changed during judge\n`,
        );
        return JSON.stringify(extraction());
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "incomplete");
  assert.match(result.errors[0].message, /source changed after module load/);
  assert.deepEqual(result.claims, []);
});
