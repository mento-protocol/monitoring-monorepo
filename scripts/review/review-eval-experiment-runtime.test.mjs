import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  rawCacheIdentity,
  digestObject,
} from "./review-eval-experiment-contract.mjs";
import {
  readExperimentCache,
  sha256Bytes,
} from "./review-eval-experiment-cache.mjs";
import { finderArgvDigest, skillDigest } from "./review-eval-run-plan.mjs";
import {
  enrichExperimentNovelty,
  parseContestantEnvelope,
  runExperimentRuntimeStage,
} from "./review-eval-experiment-runtime.mjs";

const digest = (character) => character.repeat(64);
const head = (number) => number.toString(16).padStart(40, "0");

function makeHarness({ laneCount = 3, live = false } = {}) {
  const root = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-runtime-"),
  );
  const repoRoot = path.join(root, "repo");
  const artifactRoot = path.join(root, "artifacts");
  const fixtureCacheDir = path.join(root, "fixtures");
  mkdirSync(repoRoot, { recursive: true });
  const incumbentSkill = path.join(root, "incumbent");
  const candidateSkill = path.join(root, "candidate");
  for (const [skillRoot, marker] of [
    [incumbentSkill, "incumbent reference"],
    [candidateSkill, "candidate reference"],
  ]) {
    mkdirSync(path.join(skillRoot, "references"), { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: test-review\n---\nRead `references/tooling.md`.\n",
    );
    writeFileSync(path.join(skillRoot, "references", "tooling.md"), marker);
  }
  const handoff = path.join(repoRoot, "handoff.md");
  writeFileSync(
    handoff,
    "Other review:\n{{OTHER_REVIEW}}\nReview this change.\n",
  );
  const contract = {
    sut: {
      finder: { argv: ["finder", "review"] },
    },
  };
  const plannedFinderDigest = finderArgvDigest(contract);
  const lanes = Array.from({ length: laneCount }, (_unused, index) => {
    const pr = 2000 + index;
    const truthFile = path.join(repoRoot, `truth-${pr}.json`);
    const reportFile = path.join(repoRoot, `report-${pr}.md`);
    const truth = {
      reviewers: [],
      findings: [
        {
          id: 1,
          path: "file.js",
          line: 1,
          severity: "P1",
          title: "The file has a defect",
          body: "The defect breaks the request.",
          author: null,
          acted_on: true,
        },
      ],
    };
    writeFileSync(truthFile, `${JSON.stringify(truth)}\n`);
    writeFileSync(reportFile, `Pinned finder report for PR ${pr}.\n`);
    const pairedOrder = index % 2 === 0 ? "AB" : "BA";
    return {
      lane_id: `${live ? "live-paired" : "screen"}-pr-${pr}`,
      pr,
      paired_order: pairedOrder,
      fixture: {
        first_head: head(index + 1),
        base_sha: head(index + 11),
        truth_file: path.relative(repoRoot, truthFile),
        truth_sha256: sha256Bytes(readFileSync(truthFile)),
        scorable_ids: [1],
        p1_ids: [1],
      },
      source: live
        ? {
            kind: "live-finder",
            finder_id: `live-pr-${pr}`,
            shared: true,
            finder_argv_digest: plannedFinderDigest,
          }
        : {
            kind: "frozen-report",
            report_index: 0,
            file: path.relative(repoRoot, reportFile),
            sha256: sha256Bytes(readFileSync(reportFile)),
          },
      sequence:
        pairedOrder === "AB"
          ? ["incumbent", "candidate"]
          : ["candidate", "incumbent"],
    };
  });
  const stage = live ? "live-paired" : "screen";
  const planBase = {
    schema_version: 1,
    campaign_id: "campaign-1",
    contract_digest: digest("c"),
    inputs: {
      scorer_digest: digest("s"),
      finder_argv_digest: plannedFinderDigest,
      cli_versions: {
        claude: "claude-test",
        codex: "codex-test",
        judge: "judge-test",
      },
      models: {
        finder: { model: "finder", effort: "high" },
        verifier: { model: "verifier", effort: "high" },
        control: { model: "control", effort: "high" },
        judge: { model: "judge", effort: "high" },
      },
      prompts: {
        handoff: {
          file: path.relative(repoRoot, handoff),
          sha256: sha256Bytes(readFileSync(handoff)),
        },
      },
    },
    incumbent: {
      id: "incumbent",
      skill_ref: incumbentSkill,
      skill_digest: skillDigest(incumbentSkill),
    },
    candidate: {
      id: "candidate-1",
      skill_ref: candidateSkill,
      skill_digest: skillDigest(candidateSkill),
    },
    stages: {
      [stage]: { stage, enabled: true, lanes },
    },
  };
  const plan = { ...planBase, plan_digest: digestObject(planBase) };
  const fixturePaths = new Map();
  const prepareFixture = async ({ lane }) => {
    if (!fixturePaths.has(lane.lane_id)) {
      const fixturePath = path.join(fixtureCacheDir, lane.lane_id);
      mkdirSync(fixturePath, { recursive: true });
      fixturePaths.set(lane.lane_id, { path: fixturePath, forbidden: [] });
    }
    return fixturePaths.get(lane.lane_id);
  };
  return {
    root,
    repoRoot,
    artifactRoot,
    fixtureCacheDir,
    plan,
    contract,
    stage,
    lanes,
    prepareFixture,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function judgeExec(events = []) {
  return async ({ prompt }) => {
    if (prompt.startsWith("Below is a code review.")) {
      events.push("extract");
      return JSON.stringify(["file.js:1 has a defect"]);
    }
    if (prompt.startsWith("You are matching a code review")) {
      events.push("match");
      return JSON.stringify({
        matches: [1],
        reasoning: { 1: "the review names the defect" },
      });
    }
    if (prompt.startsWith("You are verifying claims")) {
      events.push("novel");
      return JSON.stringify({
        verdicts: {
          1: { class: "wrong", why: "the fixture disproves the claim" },
        },
      });
    }
    throw new Error("unexpected judge prompt");
  };
}

function baseOptions(harness, overrides = {}) {
  return {
    plan: harness.plan,
    stage: harness.stage,
    contract: harness.contract,
    artifactRoot: harness.artifactRoot,
    repoRoot: harness.repoRoot,
    fixtureCacheDir: harness.fixtureCacheDir,
    prepareFixture: harness.prepareFixture,
    reset: async () => true,
    scorerDigestNow: () => harness.plan.inputs.scorer_digest,
    judgeExec: judgeExec(),
    contestantExec: async () =>
      JSON.stringify({ is_error: false, result: "file.js:1 has a defect" }),
    ...overrides,
  };
}

test("runtime bounds fixture lanes and preserves each recorded pair order", async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  const starts = new Map();
  const resets = [];
  let active = 0;
  let maximum = 0;
  const result = await runExperimentRuntimeStage(
    baseOptions(harness, {
      concurrency: 2,
      reset: async ({ cellId }) => {
        resets.push(cellId);
        return true;
      },
      contestantExec: async ({ lane, treatment }) => {
        if (!starts.has(lane.lane_id)) starts.set(lane.lane_id, []);
        starts.get(lane.lane_id).push(treatment);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return JSON.stringify({
          is_error: false,
          result: "file.js:1 has a defect",
        });
      },
    }),
  );
  assert.equal(result.records.length, 6);
  assert.equal(maximum, 2);
  for (const lane of harness.lanes) {
    assert.deepEqual(starts.get(lane.lane_id), lane.sequence);
    for (const treatment of lane.sequence) {
      const id = `${lane.lane_id}-${treatment}`;
      assert.equal(resets.includes(id), true);
      assert.equal(resets.includes(`${id}-extract`), true);
      assert.equal(resets.includes(`${id}-match`), true);
    }
  }
  await assert.rejects(
    runExperimentRuntimeStage(baseOptions(harness, { concurrency: 4 })),
    /concurrency must be 1\.\.3/,
  );
  const disabledPlan = structuredClone(harness.plan);
  disabledPlan.stages[harness.stage].enabled = false;
  await assert.rejects(
    runExperimentRuntimeStage(baseOptions(harness, { plan: disabledPlan })),
    /stage screen is disabled/,
  );
  const oversized = makeHarness({ laneCount: 4 });
  t.after(oversized.cleanup);
  await assert.rejects(
    runExperimentRuntimeStage(baseOptions(oversized)),
    /exceeds three fixture lanes/,
  );
});

test("one live finder report is shared by both arms", async (t) => {
  const harness = makeHarness({ laneCount: 1, live: true });
  t.after(harness.cleanup);
  const prompts = [];
  const staged = [];
  let finderCalls = 0;
  const result = await runExperimentRuntimeStage(
    baseOptions(harness, {
      finderExec: async () => {
        finderCalls += 1;
        return "one shared live finder report";
      },
      contestantExec: async ({ argv, fixturePath, prompt, treatment }) => {
        prompts.push(prompt);
        const systemPromptIndex = argv.indexOf("--append-system-prompt");
        assert.notEqual(systemPromptIndex, -1);
        assert.equal(argv[systemPromptIndex + 1].includes("---\nname:"), false);
        assert.equal(
          argv[systemPromptIndex + 1].includes(
            "  - .skill/references/tooling.md",
          ),
          true,
        );
        staged.push({
          fixturePath,
          treatment,
          reference: readFileSync(
            path.join(fixturePath, ".skill", "references", "tooling.md"),
            "utf8",
          ),
        });
        return JSON.stringify({
          is_error: false,
          result: "file.js:1 has a defect",
        });
      },
    }),
  );
  assert.equal(finderCalls, 1);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1]);
  assert.deepEqual(
    staged.map(({ treatment, reference }) => ({ treatment, reference })),
    harness.lanes[0].sequence.map((treatment) => ({
      treatment,
      reference: `${treatment} reference`,
    })),
  );
  assert.equal(existsSync(path.join(staged[0].fixturePath, ".skill")), false);
  assert.equal(
    result.records[0].raw_digest === result.records[1].raw_digest,
    false,
  );
  const rawPayloads = result.records.map((record) =>
    JSON.parse(readFileSync(record.artifacts.raw, "utf8")),
  );
  assert.equal(
    rawPayloads[0].payload.source_digest,
    rawPayloads[1].payload.source_digest,
  );
  assert.equal(
    rawPayloads[0].payload.source_report,
    "one shared live finder report",
  );
  await assert.rejects(
    runExperimentRuntimeStage(
      baseOptions(harness, {
        contract: { sut: { finder: { argv: ["finder", "changed"] } } },
        finderExec: async () => {
          throw new Error("unplanned finder ran");
        },
      }),
    ),
    /finder argv differs from the plan/,
  );
});

test("successful empty output is cached and malformed output is not", async (t) => {
  const emptyHarness = makeHarness({ laneCount: 1 });
  t.after(emptyHarness.cleanup);
  let calls = 0;
  const first = await runExperimentRuntimeStage(
    baseOptions(emptyHarness, {
      contestantExec: async ({ treatment }) => {
        calls += 1;
        return JSON.stringify({
          is_error: false,
          result: treatment === "candidate" ? "   " : "file.js:1 has a defect",
        });
      },
    }),
  );
  const candidate = first.records.find(
    (record) => record.treatment === "candidate",
  );
  assert.equal(candidate.empty, true);
  assert.equal(candidate.claims_count, 0);
  const source = emptyHarness.lanes[0].source;
  const rawIdentity = rawCacheIdentity({
    plan: emptyHarness.plan,
    stage: emptyHarness.stage,
    lane: emptyHarness.lanes[0],
    treatment: "candidate",
    sourceDigest: source.sha256,
  });
  assert.equal(
    readExperimentCache({
      artifactRoot: emptyHarness.artifactRoot,
      kind: "raw",
      identity: rawIdentity,
    }).payload.output,
    "   ",
  );
  const reused = await runExperimentRuntimeStage(
    baseOptions(emptyHarness, {
      contestantExec: async () => {
        throw new Error("cached contestant ran again");
      },
      judgeExec: async () => {
        throw new Error("cached judge ran again");
      },
    }),
  );
  assert.equal(calls, 2);
  assert.equal(
    reused.records.every(
      (record) => record.cache_reuse.raw && record.cache_reuse.score,
    ),
    true,
  );

  const malformedHarness = makeHarness({ laneCount: 1 });
  t.after(malformedHarness.cleanup);
  await assert.rejects(
    runExperimentRuntimeStage(
      baseOptions(malformedHarness, {
        contestantExec: async () => "not JSON",
      }),
    ),
    /malformed JSON/,
  );
  const rawDir = path.join(malformedHarness.artifactRoot, "cache", "raw");
  assert.equal(existsSync(rawDir) ? readdirSync(rawDir).length : 0, 0);
  assert.throws(() => parseContestantEnvelope('{"is_error":true}'), /usable/);
  assert.throws(
    () => parseContestantEnvelope('{"result":"finding"}'),
    /usable/,
  );
  assert.throws(
    () => parseContestantEnvelope('{"is_error":"false","result":"finding"}'),
    /usable/,
  );
});

test("runtime rejects scorer drift after a contestant finishes", async (t) => {
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  let currentDigest = harness.plan.inputs.scorer_digest;
  await assert.rejects(
    runExperimentRuntimeStage(
      baseOptions(harness, {
        scorerDigestNow: () => currentDigest,
        contestantExec: async () => {
          currentDigest = digest("x");
          return JSON.stringify({
            is_error: false,
            result: "file.js:1 has a defect",
          });
        },
        judgeExec: async () => {
          throw new Error("drifted scorer reached a judge");
        },
      }),
    ),
    /re-plan before scoring/,
  );
  const scoreDir = path.join(harness.artifactRoot, "cache", "score");
  assert.equal(existsSync(scoreDir) ? readdirSync(scoreDir).length : 0, 0);
});

test("runtime rejects scorer drift during judging before publication", async (t) => {
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  let currentDigest = harness.plan.inputs.scorer_digest;
  let judgeCalls = 0;
  await assert.rejects(
    runExperimentRuntimeStage(
      baseOptions(harness, {
        scorerDigestNow: () => currentDigest,
        judgeExec: async ({ prompt }) => {
          judgeCalls += 1;
          if (prompt.startsWith("Below is a code review.")) {
            return JSON.stringify(["file.js:1 has a defect"]);
          }
          if (prompt.startsWith("You are matching a code review")) {
            currentDigest = digest("x");
            return JSON.stringify({ matches: [1], reasoning: {} });
          }
          throw new Error("unexpected judge prompt");
        },
      }),
    ),
    /re-plan before scoring/,
  );
  assert.equal(judgeCalls, 2);
  const scoreDir = path.join(harness.artifactRoot, "cache", "score");
  assert.equal(existsSync(scoreDir) ? readdirSync(scoreDir).length : 0, 0);
});

test("novel scoring follows base scoring and reuses its cache", async (t) => {
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const events = [];
  const base = await runExperimentRuntimeStage(
    baseOptions(harness, { judgeExec: judgeExec(events) }),
  );
  const holdoutLane = {
    ...structuredClone(harness.lanes[0]),
    lane_id: `holdout-pr-${harness.lanes[0].pr}`,
  };
  harness.plan.stages.holdout = {
    stage: "holdout",
    enabled: true,
    lanes: [holdoutLane],
  };
  const allRecords = [
    ...base.records,
    ...base.records.map((record) => ({
      ...record,
      stage: "holdout",
      cell_id: `${holdoutLane.lane_id}-${record.treatment}`,
    })),
  ];
  let currentNovelDigest = harness.plan.inputs.scorer_digest;
  await assert.rejects(
    enrichExperimentNovelty({
      plan: harness.plan,
      records: base.records,
      contract: harness.contract,
      artifactRoot: harness.artifactRoot,
      repoRoot: harness.repoRoot,
      fixtureCacheDir: harness.fixtureCacheDir,
      prepareFixture: harness.prepareFixture,
      reset: async () => true,
      scorerDigestNow: () => currentNovelDigest,
      judgeExec: async () => {
        currentNovelDigest = digest("x");
        return JSON.stringify({
          verdicts: {
            1: { class: "wrong", why: "the fixture disproves the claim" },
          },
        });
      },
    }),
    /re-plan before scoring/,
  );
  const novelDir = path.join(harness.artifactRoot, "cache", "novel");
  assert.equal(existsSync(novelDir) ? readdirSync(novelDir).length : 0, 0);
  let prepareCalls = 0;
  const enriched = await enrichExperimentNovelty({
    plan: harness.plan,
    records: allRecords,
    contract: harness.contract,
    artifactRoot: harness.artifactRoot,
    repoRoot: harness.repoRoot,
    fixtureCacheDir: harness.fixtureCacheDir,
    prepareFixture: (options) => {
      prepareCalls += 1;
      return harness.prepareFixture(options);
    },
    reset: async () => true,
    scorerDigestNow: () => harness.plan.inputs.scorer_digest,
    judgeExec: judgeExec(events),
  });
  assert.deepEqual(events, [
    "extract",
    "match",
    "extract",
    "match",
    "novel",
    "novel",
  ]);
  assert.equal(prepareCalls, 1);
  assert.equal(
    enriched.every((record) => record.wrong_claims === 1),
    true,
  );
  const reused = await enrichExperimentNovelty({
    plan: harness.plan,
    records: allRecords,
    contract: harness.contract,
    artifactRoot: harness.artifactRoot,
    repoRoot: harness.repoRoot,
    fixtureCacheDir: harness.fixtureCacheDir,
    prepareFixture: harness.prepareFixture,
    reset: async () => true,
    scorerDigestNow: () => harness.plan.inputs.scorer_digest,
    judgeExec: async () => {
      throw new Error("cached novel judge ran again");
    },
  });
  assert.equal(
    reused.every((record) => record.cache_reuse.novel === true),
    true,
  );
});

test("runtime leaves the canonical ledger untouched", async (t) => {
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const ledger = path.join(harness.repoRoot, "review-skill-runs.json");
  writeFileSync(ledger, "ledger sentinel\n");
  await runExperimentRuntimeStage(baseOptions(harness));
  assert.equal(readFileSync(ledger, "utf8"), "ledger sentinel\n");
  assert.deepEqual(readdirSync(harness.artifactRoot), ["cache"]);
});
