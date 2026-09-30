import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
