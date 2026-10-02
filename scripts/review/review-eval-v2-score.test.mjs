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
import { metricSummary } from "./review-eval-v2-report.mjs";

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

test("duplicate claim text fails extraction regardless of quote or surrounding whitespace", async () => {
  for (const defects of [[root], []]) {
    for (const duplicate of [
      claim("The null input crashes."),
      { text: "The null input crashes.", quote: "null input crashes" },
      { text: "  The null input crashes.\n", quote: "null input crashes" },
    ]) {
      const requests = [];
      const result = await scoreReview({
        review: review("The null input crashes."),
        defects,
        fixturePath: "/unused",
        sourceDiff: "complete working-tree diff",
        judge: judgeSequence(
          [
            extraction(claim("The null input crashes."), duplicate),
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

test("uncertain roots without linked claims fail matching before source classification", async () => {
  const requests = [];
  const result = await scoreReview({
    review: review("The null input crashes."),
    defects: [root],
    fixturePath: "/unused",
    sourceDiff: "complete working-tree diff",
    judge: judgeSequence(
      [
        extraction(claim("The null input crashes.")),
        {
          defects: [match({ verdict: "uncertain", claim_ids: [], quote: "" })],
        },
        {
          novel: [
            {
              claim_id: "c1",
              verdict: "unsupported",
              reason: "No verifiable trigger.",
            },
          ],
        },
      ],
      requests,
    ),
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.coverage.matching, "incomplete");
  assert.match(result.errors[0]?.message ?? "", /uncertain.*without a claim/);
  assert.deepEqual(
    result.defects,
    [],
    "invalid uncertainty must not reach the report reducer",
  );
  assert.equal(
    result.claims[0].id,
    "c1",
    "retain extracted evidence for diagnosis",
  );
  assert.deepEqual(result.novel, []);
  assert.equal(
    requests.length,
    2,
    "stop before unrelated source-only classification",
  );
});

test("every matched claim needs quote support; an independent claim still reaches classification", async () => {
  const text = "The null input crashes.";
  const other = "An unrelated list loses data.";
  for (const mode of ["unsupported-link", "separate", "shared-support"]) {
    const requests = [];
    const result = await scoreReview({
      review: review(`${text} ${other}`),
      defects: [root],
      fixturePath: "/unused",
      sourceDiff: "complete working-tree diff",
      judge: judgeSequence(
        [
          extraction(
            claim(text),
            mode === "shared-support"
              ? {
                  text: "Null input dereferences an absent value.",
                  quote: text,
                }
              : claim(other),
          ),
          {
            defects: [
              match({ claim_ids: mode === "separate" ? ["c1"] : ["c1", "c2"] }),
            ],
          },
          {
            novel: [
              {
                claim_id: "c2",
                verdict: "unsupported",
                reason: "No supported trigger.",
              },
            ],
          },
        ],
        requests,
      ),
    });
    if (mode === "unsupported-link") {
      assert.equal(result.status, "incomplete");
      assert.equal(result.coverage.matching, "incomplete");
      assert.match(
        result.errors[0]?.message ?? "",
        /quote.*every linked claim/,
      );
      assert.deepEqual(
        result.defects,
        [],
        "do not accept a link that hides an unclassified claim",
      );
      assert.deepEqual(result.novel, []);
      assert.equal(
        result.claims.length,
        2,
        "retain both extracted claims for diagnosis",
      );
      assert.equal(requests.length, 2);
    } else {
      assert.equal(result.status, "complete");
      assert.deepEqual(result.errors, []);
      assert.equal(result.defects[0].verdict, "matched");
      assert.equal(requests.length, mode === "separate" ? 3 : 2);
      if (mode === "separate") {
        assert.equal(result.novel[0].claim_id, "c2");
        assert.equal(result.novel[0].verdict, "unsupported");
      } else assert.deepEqual(result.defects[0].claim_ids, ["c1", "c2"]);
    }
  }
});

test("a claim cannot satisfy two matched roots; distinct claims can", async () => {
  const text = "The null input crashes.";
  const second = "The empty list hangs.";
  const roots = [root, { ...root, id: "root-2", mechanism: "infinite loop" }];
  for (const shared of [true, false]) {
    const requests = [];
    const result = await scoreReview({
      review: review(`${text} ${second}`),
      defects: roots,
      judge: judgeSequence(
        [
          extraction(
            { text, quote: `${text} ${second}` },
            { text: second, quote: `${text} ${second}` },
          ),
          {
            defects: [
              match(),
              match({
                id: "root-2",
                claim_ids: shared ? ["c1", "c2"] : ["c2"],
                quote: second,
              }),
            ],
          },
        ],
        requests,
      ),
    });
    assert.equal(requests.length, 2);
    assert.equal(result.status, shared ? "incomplete" : "complete");
    if (shared) {
      assert.equal(result.coverage.matching, "incomplete");
      assert.match(result.errors[0].message, /claim.*multiple matched roots/);
      assert.deepEqual(result.defects, []);
    } else {
      assert.deepEqual(result.errors, []);
      assert.equal(
        result.defects.filter((item) => item.verdict === "matched").length,
        2,
      );
    }
  }
});

test("uncertain-linked claims stay visible but cannot become definitive novelty or false claims", async (context) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "v2-uncertain-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(path.join(fixture, "source"), "verified source quote");
  for (const variant of ["original", "repaired"]) {
    for (const verdict of ["model-supported", "wrong", "unsupported"]) {
      await context.test(`${variant}/${verdict}`, async () => {
        const requests = [];
        const result = await scoreReview({
          review: review("The null input crashes."),
          defects: [root],
          fixturePath: fixture,
          sourceDiff: "complete working-tree diff",
          judge: judgeSequence(
            [
              extraction(claim("The null input crashes.")),
              {
                defects: [
                  match({
                    verdict: "uncertain",
                    reason: "Mechanism unresolved.",
                  }),
                ],
              },
              {
                novel: [
                  {
                    claim_id: "c1",
                    verdict,
                    reason: "Source-only diagnosis.",
                    evidence: [
                      { path: "source", quote: "verified source quote" },
                    ],
                  },
                ],
              },
            ],
            requests,
          ),
        });
        const metrics = metricSummary([
          {
            treatment: "incumbent",
            variant,
            case_id: "case",
            family_id: "family",
            expected_root_ids: variant === "original" ? [root.id] : [],
            negative_control_root_ids: variant === "repaired" ? [root.id] : [],
            score: result,
          },
        ]).arms.incumbent;
        assert.equal(metrics.model_supported_novel, 0);
        assert.equal(metrics.wrong, 0);
        assert.equal(metrics.unsupported, 0);
        assert.equal(metrics.repaired_wrong_or_unsupported, 0);
        assert.equal(result.status, "incomplete");
        assert.deepEqual(result.errors, []);
        assert.equal(result.coverage.matching, "incomplete");
        assert.deepEqual(result.defects[0].claim_ids, ["c1"]);
        assert.equal(result.claims[0].id, "c1");
        assert.deepEqual(result.novel, []);
        assert.equal(
          requests.length,
          2,
          "unresolved claims must not reach source-only classification",
        );
      });
    }
  }
});

test("matched and uncertain links retain root uncertainty without double routing novelty", async () => {
  const result = await scoreReview({
    review: review("The null input crashes."),
    defects: [root, { ...root, id: "root-2" }],
    judge: judgeSequence([
      extraction(claim("The null input crashes.")),
      { defects: [match(), match({ id: "root-2", verdict: "uncertain" })] },
    ]),
  });
  const metrics = metricSummary([
    {
      treatment: "incumbent",
      expected_root_ids: [root.id, "root-2"],
      score: result,
    },
  ]).arms.incumbent;
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.errors, []);
  assert.equal(metrics.known_matched, 1);
  assert.equal(metrics.uncertain_count, 1);
  assert.equal(metrics.known_recall, null);
  assert.deepEqual(result.novel, []);
  const repaired = metricSummary([
    {
      treatment: "incumbent",
      variant: "repaired",
      expected_root_ids: [],
      negative_control_root_ids: [root.id, "root-2"],
      score: result,
    },
  ]).arms.incumbent;
  assert.equal(repaired.repaired_root_accusations, 1);
  assert.equal(
    repaired.wrong,
    1,
    "a separate definite repaired-root match remains a false claim",
  );
  assert.equal(result.defects[1].verdict, "uncertain");
});

test("uncertain matches and unverified claims remain visible without becoming misses or false alarms", async () => {
  const result = await scoreReview({
    review: review(
      "The null input crashes. An independent caller loses value.",
    ),
    defects: [root],
    fixturePath: "/unused",
    sourceDiff: "complete working-tree diff",
    judge: judgeSequence([
      extraction(
        claim("The null input crashes."),
        claim("An independent caller loses value."),
      ),
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
            claim_id: "c2",
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
  assert.equal(result.novel[0].claim_id, "c2");
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
    "review-eval-v2-grading.mjs",
    "review-eval-v2-runner.mjs",
    "review-eval-v2.mjs",
    "review-eval-v2-dataset.mjs",
    "review-eval-v2-probe-trust.mjs",
    "review-eval-experiment-cache.mjs",
    "review-eval-fixtures.mjs",
    "build-fixture.sh",
    "review-eval-run-plan.mjs",
    "review-eval-v2-judge-provider.mjs",
    "review-eval-v2-provider.mjs",
    "review-eval-run-execution.mjs",
    "review-eval-experiment-contract.mjs",
    "review-eval-run-cell.mjs",
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
  for (const file of [
    "review-eval-v2-report.mjs",
    "review-eval-v2-grading.mjs",
    "review-eval-v2-runner.mjs",
    "review-eval-v2.mjs",
    "review-eval-v2-dataset.mjs",
    "review-eval-v2-probe-trust.mjs",
    "review-eval-experiment-cache.mjs",
    "review-eval-fixtures.mjs",
    "build-fixture.sh",
    "review-eval-run-plan.mjs",
    "review-eval-v2-judge-provider.mjs",
    "review-eval-v2-provider.mjs",
    "review-eval-run-execution.mjs",
    "review-eval-experiment-contract.mjs",
    "review-eval-run-cell.mjs",
  ]) {
    await context.test(file, async (child) => {
      const { copy, scorer } = await copiedScorer(child);
      const source = path.join(copy, file);
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
              source,
              `${readFileSync(source, "utf8")}\n// changed during judge\n`,
            );
            return JSON.stringify(extraction());
          },
        },
      });
      assert.equal(calls, 1);
      assert.equal(result.status, "incomplete");
      assert.match(
        result.errors[0].message,
        /source changed after module load/,
      );
      assert.deepEqual(result.claims, []);
    });
  }
});
