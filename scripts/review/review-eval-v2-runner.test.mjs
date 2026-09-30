import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  readFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
import { digestObject } from "./review-eval-experiment-contract.mjs";
import { main } from "./review-eval-v2.mjs";
import { sha256Bytes } from "./review-eval-experiment-cache.mjs";

const skill = { skill_digest: "skill-a" };
const plan = {
  skills: { incumbent: skill, candidate: skill },
  model: "model",
  effort: "high",
  cli_version: "1",
  prompt_sha256: "prompt",
  execution_digest: "execution",
  billing_mode: "subscription",
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
    "billing_mode",
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

test("subscription usage remains diagnostic after large and unknown values", () => {
  const ledger = { billing_mode: "subscription", limit_usd: null, calls: [] };
  const first = reserveCall(ledger, "review");
  settleCall(first, { is_error: false, total_cost_usd: 1000 });
  const second = reserveCall(ledger, "retry");
  settleCall(second, { is_error: true });
  assert.equal(second.reserved_usd, null);
  assert.equal(second.actual_usd, null);
  const report = campaignReport({ plan, rows: [], spend: ledger });
  assert.equal(report.cost.actual_known_usd, 1000);
  assert.equal(report.cost.unknown_cost_calls, 1);
  assert.equal(report.cost.limit_usd, null);
  assert.match(report.cost.note, /not account charges/);
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
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "claude"),
    '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 99\nprintf "%s\\n" "claude-test-version"\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  context.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
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

test("rescoring requires the planned case set before provider or spend access", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "review-v2-case-panel-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const cli = path.join(bin, "claude");
  const versionStub =
    '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 99\nprintf "%s\\n" "claude-test-version"\n';
  writeFileSync(cli, versionStub, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  context.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const skillDir = path.join(directory, "skill");
  mkdirSync(skillDir);
  writeFileSync(path.join(skillDir, "SKILL.md"), "Review the code.");
  const dataDir = path.join(directory, "datasets");
  cpSync(path.join(REPO_ROOT, "docs/evals/review-skill-v2"), dataDir, {
    recursive: true,
  });
  const fullFile = path.join(dataDir, "dataset.json");
  const full = JSON.parse(readFileSync(fullFile, "utf8"));
  const subset = structuredClone(full);
  subset.cases = subset.cases.filter((item) => item.family_id === "pr-1984");
  subset.roots = subset.roots.filter((item) => item.family_id === "pr-1984");
  const subsetFile = path.join(dataDir, "subset.json");
  writeFileSync(subsetFile, JSON.stringify(subset));
  const options = { incumbent: skillDir, candidate: skillDir };
  const subsetOut = path.join(directory, "subset-run");
  const fullOut = path.join(directory, "full-run");
  const newPlan = makePlan({
    ...options,
    datasetFile: subsetFile,
    out: subsetOut,
  });
  assert.equal(newPlan.billing_mode, "subscription");
  assert.equal(Object.hasOwn(newPlan, "budget_usd"), false);
  makePlan({ ...options, datasetFile: fullFile, out: fullOut });
  // Both panels are valid. A mismatch must fail before even asking CLI version.
  writeFileSync(cli, "#!/bin/sh\nexit 99\n");
  await assert.rejects(
    runCampaign({ out: subsetOut, scoreOnly: true, datasetFile: fullFile }),
    /dataset case set differs from plan/,
  );
  await assert.rejects(
    runCampaign({ out: fullOut, scoreOnly: true, datasetFile: subsetFile }),
    /dataset case set differs from plan/,
  );
  for (const out of [subsetOut, fullOut]) {
    assert.equal(existsSync(path.join(out, "active.lock")), false);
    assert.equal(existsSync(path.join(out, "spend.json")), false);
    assert.equal(existsSync(path.join(out, "report.json")), false);
  }
  writeFileSync(cli, versionStub);
  subset.cases.reverse();
  subset.roots[0].title += " (revised label)";
  const reorderedFile = path.join(dataDir, "reordered.json");
  writeFileSync(reorderedFile, JSON.stringify(subset));
  const report = await runCampaign({
    out: subsetOut,
    scoreOnly: true,
    datasetFile: reorderedFile,
  });
  assert.match(report.failure, /no compatible raw result/);
  assert.equal(report.cost.actual_known_usd, 0);
});

test("legacy dollar plans are refused before provider access without rewriting artifacts", async (context) => {
  const out = mkdtempSync(path.join(tmpdir(), "v2-legacy-plan-"));
  context.after(() => rmSync(out, { recursive: true, force: true }));
  const legacy = { ...plan, budget_usd: 60 };
  delete legacy.billing_mode;
  const bytes = JSON.stringify({
    ...legacy,
    plan_digest: digestObject(legacy),
  });
  const file = path.join(out, "plan.json");
  writeFileSync(file, bytes);
  await assert.rejects(runCampaign({ out }), /legacy dollar-budget plan/);
  assert.equal(readFileSync(file, "utf8"), bytes);
  assert.equal(existsSync(path.join(out, "spend.json")), false);
  assert.equal(existsSync(path.join(out, "active.lock")), false);
});

test("retired dollar arguments are rejected explicitly before planning or auth", async () => {
  await assert.rejects(main(["plan", "--budget", "60"]), /--budget is retired/);
  assert.throws(
    () => makePlan({ out: path.join(tmpdir(), "unused-v2-plan"), budget: 60 }),
    /--budget is retired/,
  );
});

test("execution identity pins host probe code but permits label and grader changes", async (context) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "review-v2-probe-identity-"),
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const copy = path.join(directory, "repo");
  cpSync(
    path.join(REPO_ROOT, "scripts/review"),
    path.join(copy, "scripts/review"),
    { recursive: true },
  );
  cpSync(
    path.join(REPO_ROOT, "docs/evals/review-skill-v2"),
    path.join(copy, "docs/evals/review-skill-v2"),
    { recursive: true },
  );
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "claude"),
    '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 99\nprintf "%s\\n" "claude-test-version"\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  context.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const runner = await import(
    pathToFileURL(path.join(copy, "scripts/review/review-eval-v2-runner.mjs"))
  );
  const skillDir = path.join(directory, "skill");
  mkdirSync(skillDir);
  writeFileSync(path.join(skillDir, "SKILL.md"), "Review the code.");
  const datasetFile = path.join(
    copy,
    "docs/evals/review-skill-v2/dataset.json",
  );
  const options = { datasetFile, incumbent: skillDir, candidate: skillDir };
  const out = path.join(directory, "original-plan");
  const original = runner.makePlan({ ...options, out });
  const source = JSON.parse(readFileSync(datasetFile, "utf8"));
  source.roots[0].title += " (revised label)";
  writeFileSync(datasetFile, JSON.stringify(source));
  const gradingOriginals = new Map();
  for (const file of [
    "review-eval-v2-score.mjs",
    "review-eval-v2-selection.mjs",
    "prompts/v2/judge-match.md",
  ]) {
    const target = path.join(copy, "scripts/review", file);
    const originalBytes = readFileSync(target, "utf8");
    gradingOriginals.set(target, originalBytes);
    writeFileSync(target, `${originalBytes}\n// grading-only edit\n`);
  }
  const rescored = runner.makePlan({
    ...options,
    out: path.join(directory, "rescored-plan"),
  });
  assert.equal(rescored.execution_digest, original.execution_digest);
  // Same-process grading must retain its loaded snapshot. A separate cache test
  // proves that a fresh process can rescore after a selector behavior change.
  for (const [target, bytes] of gradingOriginals) writeFileSync(target, bytes);
  const report = await runner.runCampaign({ out, scoreOnly: true });
  assert.match(report.failure, /no compatible raw result/);
  assert.equal(report.cost.actual_known_usd, 0);
  for (const [file, symbol, parameters] of [
    [
      "review-eval-v2-dataset.mjs",
      "verifyCaseProbes",
      "{ fixturePath, caseId, dataset }",
    ],
    [
      "review-eval-v2-probe-trust.mjs",
      "runAuditedProbe",
      "{ repo, item, fixturePath, script }",
    ],
    ["review-eval-experiment-contract.mjs", "digestObject", "value"],
  ]) {
    await context.test(file, async () => {
      const target = path.join(copy, "scripts/review", file);
      const originalBytes = readFileSync(target, "utf8");
      const marker = `export function ${symbol}(${parameters}) {`;
      const changed = originalBytes.replace(
        marker,
        `${marker}\n  throw new Error("probe fault sentinel");`,
      );
      assert.notEqual(
        changed,
        originalBytes,
        "fault injection must alter an execution helper",
      );
      writeFileSync(target, changed);
      try {
        const changedModule = await import(
          `${pathToFileURL(target).href}?fault`
        );
        assert.throws(() => changedModule[symbol]({}), /probe fault sentinel/);
        await assert.rejects(
          runner.runCampaign({ out }),
          /execution source changed since plan/,
        );
        const stale = await runner.runCampaign({ out, scoreOnly: true });
        assert.equal(stale.status, "incomplete");
        assert.match(stale.failure, /scoring source changed after module load/);
        assert.equal(stale.metrics, null);
        const revised = runner.makePlan({
          ...options,
          out: path.join(directory, file),
        });
        assert.notEqual(revised.execution_digest, original.execution_digest);
      } finally {
        writeFileSync(target, originalBytes);
      }
    });
  }
});

test("arm order balances variants and families independently of dataset order", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "v2-arm-order-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "claude"),
    '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 99\nprintf "%s\\n" "claude-test-version"\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  context.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const skillDir = path.join(directory, "skill");
  mkdirSync(skillDir);
  writeFileSync(path.join(skillDir, "SKILL.md"), "Review the code.");
  const dataDir = path.join(directory, "dataset");
  cpSync(path.join(REPO_ROOT, "docs/evals/review-skill-v2"), dataDir, {
    recursive: true,
  });
  const datasetFile = path.join(dataDir, "dataset.json");
  const dataset = JSON.parse(readFileSync(datasetFile, "utf8"));
  let counter = 0;
  const planFor = (data) => {
    writeFileSync(datasetFile, JSON.stringify(data));
    return makePlan({
      datasetFile,
      incumbent: skillDir,
      candidate: skillDir,
      out: path.join(directory, `run-${counter++}`),
    });
  };
  const firstArms = (planned) =>
    Object.fromEntries(
      planned.cells
        .filter((_, index) => index % 2 === 0)
        .map((cell) => [cell.case_id, cell.treatment]),
    );
  const original = planFor(dataset);
  const expected = firstArms(original);
  for (const key of ["variant", "family_id"]) {
    for (const value of new Set(dataset.cases.map((item) => item[key]))) {
      const arms = dataset.cases
        .filter((item) => item[key] === value)
        .map((item) => expected[item.id])
        .sort();
      assert.deepEqual(
        arms,
        ["candidate", "incumbent"],
        `${key} ${value} must have each arm first once`,
      );
    }
  }
  assert.equal(original.arm_order.method, "family-variant-counterbalance-v1");
  assert.deepEqual(original.arm_order.family_ids, ["pr-1982", "pr-1984"]);
  const permutations = (items) =>
    items.length
      ? items.flatMap((item, index) =>
          permutations(items.filter((_, other) => index !== other)).map(
            (tail) => [item, ...tail],
          ),
        )
      : [[]];
  for (const cases of permutations(dataset.cases)) {
    const planned = planFor({ ...dataset, cases });
    assert.deepEqual(firstArms(planned), expected);
    assert.deepEqual(planned.arm_order, original.arm_order);
    assert.deepEqual(
      planned.cells
        .filter((_, index) => index % 2 === 0)
        .map((cell) => cell.case_id),
      cases.map((item) => item.id),
    );
    for (let index = 0; index < planned.cells.length; index += 2) {
      assert.equal(
        planned.cells[index].case_id,
        planned.cells[index + 1].case_id,
      );
      assert.notEqual(
        planned.cells[index].treatment,
        planned.cells[index + 1].treatment,
      );
    }
  }
  const subset = {
    ...dataset,
    cases: dataset.cases.filter((item) => item.family_id === "pr-1984"),
    roots: dataset.roots.filter((item) => item.family_id === "pr-1984"),
  };
  const oneFamily = planFor(subset);
  assert.deepEqual(oneFamily.arm_order.family_ids, ["pr-1984"]);
  assert.deepEqual(Object.values(firstArms(oneFamily)).sort(), [
    "candidate",
    "incumbent",
  ]);
});
