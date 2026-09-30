import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  executionIdentity,
  scoringIdentity,
  campaignReport,
  makePlan,
  runCampaign,
  REPO_ROOT,
  reviewerPrompt,
} from "./review-eval-v2-runner.mjs";
import { reserveCall, settleCall } from "./review-eval-v2-provider.mjs";
import { metricSummary } from "./review-eval-v2-report.mjs";
import { sha256Bytes } from "./review-eval-experiment-cache.mjs";

const skill = { skill_digest: "skill-a" };
const plan = {
  skills: { incumbent: skill, candidate: skill },
  model: "model",
  effort: "high",
  cli_version: "1",
  prompt_sha256: "prompt",
  execution_digest: "execution",
  cells: [{ case_id: "a", treatment: "incumbent" }],
};
const fixture = {
  id: "a",
  first_head: "head",
  base_sha: "base",
  expected_root_ids: ["root"],
};
const raw = (changes = {}) =>
  executionIdentity({ plan, fixture, treatment: "incumbent", ...changes });

test("raw identity excludes grader and labels, but binds every changed reviewer input", () => {
  assert.equal(
    raw().digest,
    raw({
      fixture: { ...fixture, expected_root_ids: [], labels: "new" },
      plan: { ...plan, dataset_digest: "new", grader: "new" },
    }).digest,
  );
  for (const field of [
    "model",
    "effort",
    "cli_version",
    "prompt_sha256",
    "execution_digest",
  ]) {
    assert.notEqual(
      raw().digest,
      raw({ plan: { ...plan, [field]: "changed" } }).digest,
    );
  }
  assert.notEqual(
    raw().digest,
    raw({ fixture: { ...fixture, repair: { sha256: "repair" } } }).digest,
  );
  assert.notEqual(
    raw().digest,
    raw({ fixture: { ...fixture, first_head: "other" } }).digest,
  );
  assert.notEqual(raw().digest, raw({ treatment: "candidate" }).digest);
});

test("rescoring binds raw output and every grading input", () => {
  const options = {
    rawDigest: "raw",
    datasetDigest: "labels",
    scorerDigest: "scorer",
    model: "judge",
    effort: "high",
    version: "1",
  };
  for (const key of Object.keys(options))
    assert.notEqual(
      scoringIdentity(options).digest,
      scoringIdentity({ ...options, [key]: "changed" }).digest,
    );
});

test("reservations survive failure and unknown costs; actual overshoot stops another call", () => {
  const ledger = { calls: [] };
  const first = reserveCall(ledger, 6, 5, "review");
  settleCall(first, { is_error: true });
  assert.equal(first.charged_usd, 5);
  const second = reserveCall(ledger, 6, 5, "retry");
  assert.equal(second.reserved_usd, 1);
  settleCall(second, { is_error: false, total_cost_usd: 1.2 });
  assert.throws(() => reserveCall(ledger, 6, 5, "extra"), /budget exhausted/);
});

test("missing cells and runtime errors are incomplete; uncertain valid grading remains diagnostic", () => {
  assert.equal(
    campaignReport({ plan, rows: [], spend: null }).status,
    "incomplete",
  );
  const rows = [
    {
      score: {
        status: "incomplete",
        errors: [],
        claims: [],
        defects: [],
        novel: [],
      },
    },
  ];
  const report = campaignReport({ plan, rows, spend: null });
  assert.equal(report.status, "completed");
  assert.equal(report.grading_uncertainty, true);
  assert.equal(report.qualification, "A/A harness qualification");
  assert.equal(
    campaignReport({ plan, rows, failure: "quota", spend: null }).status,
    "incomplete",
  );
});

test("matched repaired roots are false accusations and never recall hits", () => {
  const metrics = metricSummary([
    {
      treatment: "incumbent",
      variant: "repaired",
      family_id: "family",
      expected_root_ids: [],
      negative_control_root_ids: ["bug"],
      score: {
        defects: [{ id: "bug", verdict: "matched", claim_ids: ["c1"] }],
        novel: [],
      },
    },
  ]);
  assert.equal(metrics.arms.incumbent.known_matched, 0);
  assert.equal(metrics.arms.incumbent.known_recall, null);
  assert.equal(metrics.arms.incumbent.repaired_root_accusations, 1);
  assert.equal(metrics.arms.incumbent.wrong, 1);
});

test("uncertain positive roots cannot become misses, measured recall, or paired deltas", () => {
  const rows = ["incumbent", "candidate"].map((treatment) => ({
    case_id: "case",
    family_id: "family",
    treatment,
    expected_root_ids: ["bug", "miss"],
    negative_control_root_ids: [],
    roots: [
      { id: "bug", severity: "P1" },
      { id: "miss", severity: "P2" },
    ],
    score: {
      defects: [
        {
          id: "bug",
          verdict: treatment === "incumbent" ? "uncertain" : "matched",
        },
        { id: "miss", verdict: "unmatched" },
      ],
      novel: [],
    },
  }));
  const metrics = metricSummary(rows);
  assert.equal(metrics.arms.incumbent.known_recall, null);
  assert.deepEqual(
    metrics.arms.incumbent.missed_roots.map((root) => root.id),
    ["miss"],
  );
  assert.deepEqual(
    metrics.arms.incumbent.uncertain_roots.map((root) => root.id),
    ["bug"],
  );
  assert.equal(metrics.arms.incumbent.uncertain_count, 1);
  assert.equal(metrics.arms.candidate.known_recall, 0.5);
  assert.equal(metrics.by_family[0].known_match_delta, null);
});

test("wrong counts distinct claims while repaired-root accusations count roots", () => {
  const metrics = metricSummary([
    {
      treatment: "incumbent",
      case_id: "case",
      expected_root_ids: [],
      negative_control_root_ids: ["root-1", "root-2"],
      score: {
        defects: [
          { id: "root-1", verdict: "matched", claim_ids: ["c1", "c2"] },
          { id: "root-2", verdict: "matched", claim_ids: ["c1"] },
        ],
        novel: [{ claim_id: "c3", verdict: "wrong" }],
      },
    },
  ]);
  assert.equal(metrics.arms.incumbent.wrong, 3);
  assert.equal(metrics.arms.incumbent.repaired_root_accusations, 2);
  const one = metricSummary([
    {
      treatment: "incumbent",
      expected_root_ids: [],
      negative_control_root_ids: ["root-1", "root-2"],
      score: {
        defects: [
          { id: "root-1", verdict: "matched", claim_ids: ["c1"] },
          { id: "root-2", verdict: "matched", claim_ids: ["c1"] },
        ],
        novel: [],
      },
    },
  ]);
  assert.equal(one.arms.incumbent.wrong, 1);
});

test("rescoring uses recorded skill identity after a skill snapshot changes", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "review-v2-rescore-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const skillDir = path.join(directory, "skill");
  mkdirSync(skillDir);
  writeFileSync(path.join(skillDir, "SKILL.md"), "Review the code.");
  const out = path.join(directory, "campaign");
  makePlan({
    datasetFile: path.join(
      REPO_ROOT,
      "docs/evals/review-skill-v2/dataset.json",
    ),
    incumbent: skillDir,
    candidate: skillDir,
    out,
  });
  writeFileSync(path.join(skillDir, "SKILL.md"), "Changed skill.");
  await assert.rejects(runCampaign({ out }), /skill snapshot changed/);
  const report = await runCampaign({ out, scoreOnly: true });
  assert.match(report.failure, /no compatible raw result/);
  assert.equal(report.cost.actual_known_usd, 0);
});

test("each reviewer prompt uses exactly the pinned bytes and rejects late drift", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "review-v2-prompt-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "request.md");
  writeFileSync(file, "Pinned instructions.");
  const plan = { prompt_sha256: sha256Bytes("Pinned instructions.") };
  assert.equal(
    reviewerPrompt(plan, "complete diff", file),
    "Pinned instructions.\n<diff>\ncomplete diff\n</diff>\n",
  );
  writeFileSync(file, "Changed after campaign validation.");
  assert.throws(
    () => reviewerPrompt(plan, "complete diff", file),
    /review prompt changed/,
  );
});
