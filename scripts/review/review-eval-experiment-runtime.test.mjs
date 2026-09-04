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
import { experimentPolicy } from "./review-eval-experiment-grid.mjs";
import {
  recordRuntimeDrift,
  runtimeDriftReason,
  stageRuntimeChange,
} from "./review-eval-experiment-versions.mjs";
import { runStage } from "./review-eval-experiment.mjs";
import {
  readExperimentCache,
  sha256Bytes,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";
import { finderArgvDigest, skillDigest } from "./review-eval-run-plan.mjs";
import { SESSION_TEXT_BUDGET_CHARS } from "./review-eval-stream.mjs";
import {
  enrichExperimentNovelty,
  parseContestantEnvelope,
  runExperimentRuntimeStage,
} from "./review-eval-experiment-runtime.mjs";

const digest = (character) => character.repeat(64);
const head = (number) => number.toString(16).padStart(40, "0");

/**
 * One `stream-json` session: an assistant message per entry, then the closing
 * result event. `result` on that event is the LAST message, which is exactly
 * what the retired `--output-format json` envelope carried.
 */
function contestantStream(messages, resultOverrides = {}) {
  const events = messages.map((text) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text }] },
  }));
  events.push({
    type: "result",
    subtype: "success",
    is_error: false,
    result: messages.at(-1) ?? "",
    total_cost_usd: 0.5,
    num_turns: messages.length,
    session_id: "session",
    duration_ms: 1000,
    ...resultOverrides,
  });
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function makeHarness({
  laneCount = 3,
  draws = 1,
  live = false,
  stage: stageUnderTest = null,
  // Plan a screen stage beside the stage under test, so a holdout run has the
  // prerequisite it folds in.
  withScreen = false,
  cliVersions = {
    claude: "claude-test",
    codex: "codex-test",
    judge: "judge-test",
  },
} = {}) {
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
  const lanesFor = (stageName) =>
    Array.from({ length: laneCount }, (_unused, index) => {
      const pr = 2000 + index;
      return Array.from({ length: draws }, (_ignored, draw) => {
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
        const pairedOrder = (index + draw) % 2 === 0 ? "AB" : "BA";
        return {
          lane_id: `${stageName}-pr-${pr}-d${draw}`,
          pr,
          draw,
          paired_order: pairedOrder,
          fixture: {
            first_head: head(index + 1),
            base_sha: head(index + 11),
            truth_file: path.relative(repoRoot, truthFile),
            truth_sha256: sha256Bytes(readFileSync(truthFile)),
            scorable_ids: [1],
            p1_ids: [1],
          },
          source:
            stageName === "live-paired"
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
    }).flat();
  const stage = stageUnderTest ?? (live ? "live-paired" : "screen");
  const lanes = lanesFor(stage);
  const screenLanes = withScreen ? lanesFor("screen") : null;
  const planBase = {
    schema_version: 1,
    campaign_id: "campaign-1",
    contract_digest: digest("c"),
    inputs: {
      scorer_digest: digest("s"),
      finder_argv_digest: plannedFinderDigest,
      cli_versions: { ...cliVersions },
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
    policy: experimentPolicy({
      fixtures: lanes.map((lane) => lane.fixture),
      draws,
    }),
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
      ...(screenLanes
        ? { screen: { stage: "screen", enabled: true, lanes: screenLanes } }
        : {}),
      [stage]: { stage, enabled: true, lanes },
    },
  };
  const plan = { ...planBase, plan_digest: digestObject(planBase) };
  const fixturePaths = new Map();
  // Keyed on the PR, as the real cache is: every draw of a PR shares one tree.
  const prepareFixture = async ({ lane }) => {
    if (!fixturePaths.has(lane.pr)) {
      const fixturePath = path.join(fixtureCacheDir, String(lane.pr));
      mkdirSync(fixturePath, { recursive: true });
      fixturePaths.set(lane.pr, { path: fixturePath, forbidden: [] });
    }
    return fixturePaths.get(lane.pr);
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
    screenLanes,
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
    cliVersions: harness.plan.inputs.cli_versions,
    scorerDigestNow: () => harness.plan.inputs.scorer_digest,
    judgeExec: judgeExec(),
    contestantExec: async () => contestantStream(["file.js:1 has a defect"]),
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
        return contestantStream(["file.js:1 has a defect"]);
      },
    }),
  );
  assert.equal(result.records.length, harness.lanes.length * 2);
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
  // A grid wider than the concurrency cap is a longer stage, not an error.
  const wide = makeHarness({ laneCount: 4 });
  t.after(wide.cleanup);
  const wideRun = await runExperimentRuntimeStage(baseOptions(wide));
  assert.equal(wideRun.records.length, wide.lanes.length * 2);
  const emptyPlan = structuredClone(harness.plan);
  emptyPlan.stages[harness.stage].lanes = [];
  await assert.rejects(
    runExperimentRuntimeStage(baseOptions(harness, { plan: emptyPlan })),
    /plans no fixture lane/,
  );
});

test("two draws of one PR share one report and never overlap", async (t) => {
  const harness = makeHarness({ laneCount: 2, draws: 2, live: true });
  t.after(harness.cleanup);
  // Two draws of a PR reset and stage inside one tree, so an overlap between
  // them would be two cells deleting each other's working copy.
  const busy = new Set();
  const overlaps = [];
  const finderPrs = [];
  const prompts = new Map();
  let concurrentPrs = 0;
  const result = await runExperimentRuntimeStage(
    baseOptions(harness, {
      finderExec: async ({ lane }) => {
        finderPrs.push(lane.pr);
        return `one live finder report for PR ${lane.pr}`;
      },
      contestantExec: async ({ lane, prompt }) => {
        if (busy.has(lane.pr)) overlaps.push(lane.lane_id);
        busy.add(lane.pr);
        concurrentPrs = Math.max(concurrentPrs, busy.size);
        prompts.set(lane.lane_id, prompt);
        await new Promise((resolve) => setImmediate(resolve));
        busy.delete(lane.pr);
        return contestantStream(["file.js:1 has a defect"]);
      },
    }),
  );
  assert.deepEqual(overlaps, []);
  assert.equal(concurrentPrs, 2);
  // Lanes and records keep the plan's order, and each names its own draw.
  assert.deepEqual(
    result.records.map((record) => `${record.cell_id}:${record.draw}`),
    harness.lanes.flatMap((lane) =>
      lane.sequence.map(
        (treatment) => `${lane.lane_id}-${treatment}:${lane.draw}`,
      ),
    ),
  );
  const prs = [...new Set(harness.lanes.map((lane) => lane.pr))];
  // One finder run per PR group, not one per draw, and every draw reads it.
  assert.deepEqual(finderPrs.sort(), [...prs].sort());
  for (const pr of prs) {
    const [first, second] = harness.lanes.filter((lane) => lane.pr === pr);
    assert.equal(
      prompts.get(first.lane_id),
      prompts.get(second.lane_id),
      `PR ${pr} draws read different reports`,
    );
  }
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
        return contestantStream(["file.js:1 has a defect"]);
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
  // This lane does spawn the finder, so its cell carries the Codex version.
  assert.deepEqual(rawPayloads[0].payload.cli_versions, {
    claude: harness.plan.inputs.cli_versions.claude,
    codex: harness.plan.inputs.cli_versions.codex,
  });
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
        return contestantStream([
          treatment === "candidate" ? "   " : "file.js:1 has a defect",
        ]);
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
    cliVersions: emptyHarness.plan.inputs.cli_versions,
  });
  assert.equal(
    readExperimentCache({
      artifactRoot: emptyHarness.artifactRoot,
      kind: "raw",
      identity: rawIdentity,
    }).payload.output,
    // A whitespace-only message contributes no text to the session.
    "",
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
  assert.throws(
    () =>
      parseContestantEnvelope(
        contestantStream(["finding"], { is_error: true }),
      ),
    /usable/,
  );
  assert.throws(
    () =>
      parseContestantEnvelope(
        contestantStream(["finding"], { is_error: "false" }),
      ),
    /usable/,
  );
  assert.throws(
    () => parseContestantEnvelope(contestantStream(["finding"], { type: "x" })),
    /no result event/,
  );
});

test("a cell is scored on every assistant message it wrote", async (t) => {
  // The defect this replaced: two 2026-09-02 cells wrote their report, ran one
  // more tool call, then posted a short addendum, and the envelope's `result`
  // field carried the addendum alone. Both messages must reach the scorer, in
  // the order the reviewer wrote them.
  const envelope = parseContestantEnvelope(
    contestantStream(["file.js:1 has a defect", "Final addendum"]),
  );
  assert.equal(envelope.result, "file.js:1 has a defect\n\nFinal addendum");
  assert.equal(envelope.final_result, "Final addendum");
  assert.equal(envelope.assistant_messages, 2);

  // The retired single-shot envelope is no longer a shape this harness can
  // read, so a cell cannot fall back to final-message-only scoring in silence.
  assert.throws(
    () =>
      parseContestantEnvelope(
        JSON.stringify({ is_error: false, result: "Final addendum" }),
      ),
    /malformed JSON/,
  );

  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const result = await runExperimentRuntimeStage(
    baseOptions(harness, {
      contestantExec: async () =>
        contestantStream(["file.js:1 has a defect", "Final addendum"]),
    }),
  );
  for (const record of result.records) {
    const { payload } = JSON.parse(readFileSync(record.artifacts.raw, "utf8"));
    assert.equal(payload.output, "file.js:1 has a defect\n\nFinal addendum");
    assert.equal(payload.assistant_messages, 2);
  }
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
          return contestantStream(["file.js:1 has a defect"]);
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
    lane_id: `holdout-pr-${harness.lanes[0].pr}-d0`,
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
      cliVersions: harness.plan.inputs.cli_versions,
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
    cliVersions: harness.plan.inputs.cli_versions,
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
    cliVersions: harness.plan.inputs.cli_versions,
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

test("an artifact keeps the runtime that produced it across a retry", async (t) => {
  // The defect this replaced: provenance was inferred from the current
  // invocation's `cache_reuse` flags, so a stage retried after a failure
  // relabelled artifacts an upgraded CLI had produced as planned-runtime work.
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const planned = harness.plan.inputs.cli_versions;
  const upgraded = { ...planned, claude: "claude-2", judge: "judge-2" };
  const first = await runExperimentRuntimeStage(baseOptions(harness));
  for (const record of first.records) {
    assert.deepEqual(record.cli_versions, {
      raw: { claude: planned.claude },
      score: { judge: planned.judge },
    });
  }

  // The CLI upgrades. No artifact of the old runtime is found, so the cell
  // reruns and stores the versions it actually ran under.
  let contestantCalls = 0;
  const upgradedRun = await runExperimentRuntimeStage(
    baseOptions(harness, {
      cliVersions: upgraded,
      contestantExec: async () => {
        contestantCalls += 1;
        return contestantStream(["file.js:1 has a defect"]);
      },
    }),
  );
  assert.equal(contestantCalls, 2);
  for (const record of upgradedRun.records) {
    assert.deepEqual(record.cache_reuse, { raw: false, score: false });
    assert.deepEqual(record.cli_versions, {
      raw: { claude: "claude-2" },
      score: { judge: "judge-2" },
    });
    const stored = JSON.parse(readFileSync(record.artifacts.raw, "utf8"));
    assert.deepEqual(stored.payload.cli_versions, { claude: "claude-2" });
  }

  // The stage fails after those artifacts land. The retry reuses them and must
  // still report the runtime that produced them.
  const retry = await runExperimentRuntimeStage(
    baseOptions(harness, {
      cliVersions: upgraded,
      contestantExec: async () => {
        throw new Error("cached contestant ran again");
      },
      judgeExec: async () => {
        throw new Error("cached judge ran again");
      },
    }),
  );
  for (const record of retry.records) {
    assert.deepEqual(record.cache_reuse, { raw: true, score: true });
    assert.deepEqual(record.cli_versions, {
      raw: { claude: "claude-2" },
      score: { judge: "judge-2" },
    });
  }
  assert.deepEqual(
    recordRuntimeDrift({ planned, records: retry.records }).providers.map(
      (entry) => [entry.provider, entry.live, entry.cell_ids.length],
    ),
    [
      ["claude", "claude-2", 2],
      ["judge", "judge-2", 2],
    ],
  );
});

test("a novelty judge stores its own runtime and keeps it on reuse", async (t) => {
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const planned = harness.plan.inputs.cli_versions;
  const upgraded = { ...planned, judge: "judge-2" };
  const base = await runExperimentRuntimeStage(
    baseOptions(harness, { cliVersions: upgraded }),
  );
  const enrichOptions = (overrides = {}) => ({
    plan: harness.plan,
    records: base.records,
    contract: harness.contract,
    artifactRoot: harness.artifactRoot,
    repoRoot: harness.repoRoot,
    fixtureCacheDir: harness.fixtureCacheDir,
    prepareFixture: harness.prepareFixture,
    reset: async () => true,
    cliVersions: upgraded,
    scorerDigestNow: () => harness.plan.inputs.scorer_digest,
    judgeExec: judgeExec(),
    ...overrides,
  });
  const enriched = await enrichExperimentNovelty(enrichOptions());
  for (const record of enriched) {
    assert.deepEqual(record.cli_versions.novel, { judge: "judge-2" });
    const stored = JSON.parse(readFileSync(record.artifacts.novel, "utf8"));
    assert.deepEqual(stored.payload.cli_versions, { judge: "judge-2" });
  }
  const reused = await enrichExperimentNovelty(
    enrichOptions({
      judgeExec: async () => {
        throw new Error("cached novel judge ran again");
      },
    }),
  );
  assert.equal(
    reused.every((record) => record.cache_reuse.novel === true),
    true,
  );
  assert.deepEqual(recordRuntimeDrift({ planned, records: reused }).providers, [
    {
      provider: "judge",
      planned: planned.judge,
      live: "judge-2",
      cell_ids: reused.map((record) => record.cell_id).sort(),
    },
  ]);
});

function holdoutStage(harness) {
  const lanes = harness.lanes.map((lane) => ({
    ...structuredClone(lane),
    lane_id: `holdout-pr-${lane.pr}-d${lane.draw ?? 0}`,
  }));
  harness.plan.stages.holdout = { stage: "holdout", enabled: true, lanes };
  return lanes;
}

function noveltyOptions(harness, records, overrides = {}) {
  return {
    plan: harness.plan,
    records,
    contract: harness.contract,
    artifactRoot: harness.artifactRoot,
    repoRoot: harness.repoRoot,
    fixtureCacheDir: harness.fixtureCacheDir,
    prepareFixture: harness.prepareFixture,
    reset: async () => true,
    cliVersions: harness.plan.inputs.cli_versions,
    scorerDigestNow: () => harness.plan.inputs.scorer_digest,
    judgeExec: judgeExec(),
    ...overrides,
  };
}

test("a judge upgraded after the screen still loads the screen's own scores", async (t) => {
  // The defect this replaced: enrichment rebuilt every record's score identity
  // from the live judge, so screen scores recorded under judge 1 were
  // unreachable under judge 2. Enrichment threw and the campaign produced no
  // holdout decision at all.
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const planned = harness.plan.inputs.cli_versions;
  const judgeOne = { ...planned, judge: "judge-1" };
  const judgeTwo = { ...planned, judge: "judge-2" };
  const screen = await runExperimentRuntimeStage(
    baseOptions(harness, { cliVersions: judgeOne }),
  );
  holdoutStage(harness);
  const holdout = await runExperimentRuntimeStage(
    baseOptions(harness, { stage: "holdout", cliVersions: judgeTwo }),
  );
  const enriched = await enrichExperimentNovelty(
    noveltyOptions(harness, [...screen.records, ...holdout.records], {
      cliVersions: judgeTwo,
    }),
  );
  assert.equal(enriched.length, 4);
  for (const record of enriched) {
    assert.deepEqual(record.cli_versions, {
      raw: { claude: planned.claude },
      // Each phase reports the judge that ran it, not the judge probed now.
      score: { judge: record.stage === "screen" ? "judge-1" : "judge-2" },
      novel: { judge: "judge-2" },
    });
    assert.equal(record.wrong_claims, 1);
  }

  // The stage decision embeds this drift, so it names both provenances.
  const drift = recordRuntimeDrift({ planned: judgeOne, records: enriched });
  assert.deepEqual(
    drift.providers.map((entry) => [entry.provider, entry.planned, entry.live]),
    [["judge", "judge-1", "judge-2"]],
  );
  assert.deepEqual(
    drift.cell_ids,
    enriched.map((record) => record.cell_id).sort(),
  );
  assert.match(runtimeDriftReason(drift), /judge judge-1 -> judge-2 on /);
});

test("a retried novelty pass reuses every artifact under its recorded version", async (t) => {
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const planned = harness.plan.inputs.cli_versions;
  const judgeTwo = { ...planned, judge: "judge-2" };
  const judgeThree = { ...planned, judge: "judge-3" };
  const base = await runExperimentRuntimeStage(
    baseOptions(harness, { cliVersions: judgeTwo }),
  );

  // The pass classifies the first cell, then loses the judge on the second.
  let novelCalls = 0;
  await assert.rejects(
    enrichExperimentNovelty(
      noveltyOptions(harness, base.records, {
        cliVersions: judgeTwo,
        judgeExec: async (request) => {
          novelCalls += 1;
          if (novelCalls > 1) throw new Error("novel judge lost its session");
          return judgeExec()(request);
        },
      }),
    ),
    /novel judge lost its session/,
  );
  assert.equal(novelCalls, 2);

  // The retry judges only the cell that has no artifact yet.
  const retryCalls = [];
  const enriched = await enrichExperimentNovelty(
    noveltyOptions(harness, base.records, {
      cliVersions: judgeTwo,
      judgeExec: judgeExec(retryCalls),
    }),
  );
  assert.deepEqual(retryCalls, ["novel"]);
  assert.deepEqual(
    enriched.map((record) => record.cache_reuse.novel),
    [true, false],
  );

  // A later pass under a third judge still finds each score and each novelty
  // artifact through the version its own record stored.
  const reused = await enrichExperimentNovelty(
    noveltyOptions(harness, enriched, {
      cliVersions: judgeThree,
      judgeExec: async () => {
        throw new Error("cached novel judge ran again");
      },
    }),
  );
  for (const record of reused) {
    // Reaching this line at all means the score artifact was found through the
    // record's own judge version rather than the version probed now.
    assert.equal(record.cache_reuse.novel, true);
    assert.deepEqual(record.cli_versions, {
      raw: { claude: planned.claude },
      score: { judge: "judge-2" },
      novel: { judge: "judge-2" },
    });
  }
});

test("an empty transcript is scored with no judge and records no judge", async (t) => {
  // ADR 0085: an artifact records only the providers its own phase invoked.
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const planned = harness.plan.inputs.cli_versions;
  const upgraded = { ...planned, judge: "judge-2" };
  const events = [];
  const result = await runExperimentRuntimeStage(
    baseOptions(harness, {
      cliVersions: upgraded,
      judgeExec: judgeExec(events),
      contestantExec: async ({ treatment }) =>
        contestantStream([
          treatment === "candidate" ? "   " : "file.js:1 has a defect",
        ]),
    }),
  );
  const candidate = result.records.find(
    (record) => record.treatment === "candidate",
  );
  const incumbent = result.records.find(
    (record) => record.treatment === "incumbent",
  );
  assert.equal(candidate.empty, true);
  // The empty cell reaches its score without a judge call, upgrade or not.
  assert.deepEqual(events, ["extract", "match"]);
  assert.deepEqual(candidate.cli_versions.score, {});
  assert.deepEqual(incumbent.cli_versions.score, { judge: "judge-2" });
  assert.deepEqual(
    JSON.parse(readFileSync(candidate.artifacts.score, "utf8")).payload
      .cli_versions,
    {},
  );

  // The upgrade is therefore attributed to the cell that ran the judge alone.
  assert.deepEqual(recordRuntimeDrift({ planned, records: result.records }), {
    providers: [
      {
        provider: "judge",
        planned: planned.judge,
        live: "judge-2",
        cell_ids: [incumbent.cell_id],
      },
    ],
    cell_ids: [incumbent.cell_id],
    summary: `judge ${planned.judge} -> judge-2`,
  });

  const reused = await runExperimentRuntimeStage(
    baseOptions(harness, {
      cliVersions: upgraded,
      contestantExec: async () => {
        throw new Error("cached contestant ran again");
      },
      judgeExec: async () => {
        throw new Error("cached judge ran again");
      },
    }),
  );
  assert.equal(
    reused.records.every((record) => record.cache_reuse.score),
    true,
  );
});

test("novelty names the judge only on the records that invoked it", async (t) => {
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const planned = harness.plan.inputs.cli_versions;
  const upgraded = { ...planned, judge: "judge-2" };
  const base = await runExperimentRuntimeStage(
    baseOptions(harness, {
      cliVersions: upgraded,
      contestantExec: async ({ treatment }) =>
        contestantStream([
          treatment === "candidate" ? "   " : "file.js:1 has a defect",
        ]),
    }),
  );
  const events = [];
  const enriched = await enrichExperimentNovelty(
    noveltyOptions(harness, base.records, {
      cliVersions: upgraded,
      judgeExec: judgeExec(events),
    }),
  );
  // A cell with no claim is classified without a judge call.
  assert.deepEqual(events, ["novel"]);
  const candidate = enriched.find((record) => record.treatment === "candidate");
  const incumbent = enriched.find((record) => record.treatment === "incumbent");
  assert.deepEqual(candidate.cli_versions.novel, {});
  assert.equal(candidate.wrong_claims, 0);
  assert.deepEqual(incumbent.cli_versions.novel, { judge: "judge-2" });
  assert.equal(incumbent.wrong_claims, 1);
  assert.deepEqual(
    recordRuntimeDrift({ planned, records: enriched }).cell_ids,
    [incumbent.cell_id],
  );
});

test("a trimmed cell records how much of its session it kept", async (t) => {
  // The runbook promises the trimming is visible after the fact, and the
  // canonical cell writer stores all three counts. The experiment raw payload
  // stored the message count alone, so a cell whose earlier messages were cut
  // looked exactly like one that fit the budget.
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const stream = contestantStream([
    "x".repeat(SESSION_TEXT_BUDGET_CHARS),
    "file.js:1 has a defect",
  ]);
  const result = await runExperimentRuntimeStage(
    baseOptions(harness, { contestantExec: async () => stream }),
  );
  for (const record of result.records) {
    const { payload } = JSON.parse(readFileSync(record.artifacts.raw, "utf8"));
    // Only the final message fits the judge budget, so `output` is that message
    // alone and the counts say the earlier one was dropped.
    assert.equal(payload.output, "file.js:1 has a defect");
    assert.equal(payload.assistant_messages, 2);
    assert.equal(payload.assistant_messages_kept, 1);
    assert.equal(payload.stream_chars, stream.length);
    assert.equal(record.assistant_messages, 2);
    assert.equal(record.assistant_messages_kept, 1);
    assert.equal(record.stream_chars, stream.length);
  }
});

test("a mid-stage provider upgrade is named once for the whole stage", async (t) => {
  const start = { claude: "2.1.258", codex: "0.48.2" };
  const harness = makeHarness({
    laneCount: 1,
    // The plan was written under the versions the stage started with, so the
    // only difference this test can see is the one that landed mid-stage.
    cliVersions: { ...start, judge: start.claude },
  });
  t.after(harness.cleanup);
  const live = { ...start };
  const probes = [];
  const stderr = [];
  const written = t.mock.method(process.stderr, "write", (line) => {
    stderr.push(line);
    return true;
  });
  t.after(() => written.mock.restore());
  const result = await runStage(
    {
      stage: harness.stage,
      repoRoot: harness.repoRoot,
      fixtureCacheDir: harness.fixtureCacheDir,
      concurrency: 1,
    },
    {
      artifactRoot: harness.artifactRoot,
      plan: harness.plan,
      contract: harness.contract,
      env: {},
    },
    {
      // The stage-start probe reads both providers before any arm runs; the
      // CLI then updates itself while the arms run, so every later probe
      // reports the new version.
      probe: (name) => {
        probes.push(name);
        const version = live[name];
        if (probes.length >= 2) live.claude = "2.1.259";
        return version;
      },
      prepareFixture: harness.prepareFixture,
      reset: async () => true,
      scorerDigestNow: () => harness.plan.inputs.scorer_digest,
      judgeExec: judgeExec(),
      contestantExec: async () => contestantStream(["file.js:1 has a defect"]),
    },
  );
  // The stage opens with a claude and a codex probe; the frozen-report stage
  // then probes claude alone, because no cell of it can invoke codex.
  assert.deepEqual(probes, ["claude", "codex", "claude"]);
  const reason =
    "runtime changed during the screen stage: claude 2.1.258 -> 2.1.259, " +
    "judge 2.1.258 -> 2.1.259; cells that ran after the change may have " +
    "used the later version and are keyed on the earlier one";
  assert.equal(result.decision.reasons[0], reason);
  assert.deepEqual(stderr, [`warning: ${reason}\n`]);
  const change = {
    providers: [
      { provider: "claude", start: "2.1.258", end: "2.1.259" },
      { provider: "judge", start: "2.1.258", end: "2.1.259" },
    ],
    summary: "claude 2.1.258 -> 2.1.259, judge 2.1.258 -> 2.1.259",
  };
  // The change is keyed by the stage that saw it, so a later stage folding
  // this one in can carry it beside its own.
  assert.deepEqual(result.runtime_change_during_stage, { screen: change });
  assert.deepEqual(result.decision.runtime_change_during_stage, {
    screen: change,
  });
  // The change is reported for the stage and charged to no cell: every cell
  // stays recorded and keyed under the versions the stage started with.
  for (const record of result.records) {
    assert.deepEqual(record.cli_versions.raw, { claude: start.claude });
    const { payload } = JSON.parse(readFileSync(record.artifacts.raw, "utf8"));
    const identity = rawCacheIdentity({
      plan: harness.plan,
      stage: harness.stage,
      lane: harness.lanes.find((lane) => lane.pr === record.pr),
      treatment: record.treatment,
      sourceDigest: payload.source_digest,
      cliVersions: start,
    });
    assert.notEqual(
      readExperimentCache({
        artifactRoot: harness.artifactRoot,
        kind: "raw",
        identity,
      }),
      null,
    );
  }
});

test("every mid-stage probe is compared with the versions the stage started on", () => {
  const start = { claude: "2.1.258", codex: "0.48.2" };
  assert.equal(stageRuntimeChange(start, [{ ...start }]), null);
  // A second upgrade during novelty must not hide the one that landed during
  // the arms: each probe is measured against the start, not against the probe
  // before it.
  const change = stageRuntimeChange(start, [
    { claude: "2.1.259", codex: start.codex },
    { claude: "2.1.260", codex: start.codex },
  ]);
  assert.equal(
    change.summary,
    "claude 2.1.258 -> 2.1.259, claude 2.1.258 -> 2.1.260, " +
      "judge 2.1.258 -> 2.1.259, judge 2.1.258 -> 2.1.260",
  );
});

/** The cache identity `--run` stores one stage result under. */
function stageCacheIdentity(plan, stage) {
  const base = {
    schema_version: 1,
    phase: "stage",
    plan_digest: plan.plan_digest,
    stage,
  };
  return { ...base, digest: digestObject(base) };
}

/** A stored prerequisite result, so the stage under test is allowed to run. */
function seedStageResult(harness, stage, payload) {
  return writeExperimentCache({
    artifactRoot: harness.artifactRoot,
    kind: "stage",
    identity: stageCacheIdentity(harness.plan, stage),
    payload: {
      schema_version: 1,
      plan_digest: harness.plan.plan_digest,
      stage,
      ...payload,
    },
  });
}

/** One campaign run of a single stage, with the probe and hooks a test drives. */
function stageRun(harness, { stage, probe, ...overrides }) {
  return runStage(
    {
      stage,
      repoRoot: harness.repoRoot,
      fixtureCacheDir: harness.fixtureCacheDir,
      concurrency: 1,
    },
    {
      artifactRoot: harness.artifactRoot,
      plan: harness.plan,
      contract: harness.contract,
      env: {},
      // The campaign-load probe. A stage keys its cells on its own stage-start
      // probe, so this value must not reach any cell.
      liveCliVersions: { claude: "loaded-claude", codex: "loaded-codex" },
    },
    {
      probe,
      prepareFixture: harness.prepareFixture,
      reset: async () => true,
      scorerDigestNow: () => harness.plan.inputs.scorer_digest,
      judgeExec: judgeExec(),
      contestantExec: async () => contestantStream(["file.js:1 has a defect"]),
      ...overrides,
    },
  );
}

test("a stage keys its cells on the versions probed when it starts", async (t) => {
  // The plan and the campaign loaded under 2.1.258; the CLI updated before the
  // stage began. Nothing changes once the stage is running.
  const started = { claude: "2.1.259", codex: "0.48.2" };
  const harness = makeHarness({
    laneCount: 1,
    cliVersions: { ...started, judge: started.claude },
  });
  t.after(harness.cleanup);
  const stderr = [];
  const written = t.mock.method(process.stderr, "write", (line) => {
    stderr.push(line);
    return true;
  });
  t.after(() => written.mock.restore());
  const result = await stageRun(harness, {
    stage: harness.stage,
    probe: (name) => started[name],
  });
  // Keyed on the stage-start versions, so no cell is charged with a change and
  // no stage change is reported.
  assert.deepEqual(stderr, []);
  assert.equal(result.runtime_change_during_stage, undefined);
  assert.equal(result.decision.runtime_change_during_stage, undefined);
  assert.equal(
    result.decision.reasons.some((reason) =>
      reason.startsWith("runtime changed during"),
    ),
    false,
  );
  for (const record of result.records) {
    assert.deepEqual(record.cli_versions.raw, { claude: started.claude });
    const { payload } = JSON.parse(readFileSync(record.artifacts.raw, "utf8"));
    assert.notEqual(
      readExperimentCache({
        artifactRoot: harness.artifactRoot,
        kind: "raw",
        identity: rawCacheIdentity({
          plan: harness.plan,
          stage: harness.stage,
          lane: harness.lanes.find((lane) => lane.pr === record.pr),
          treatment: record.treatment,
          sourceDigest: payload.source_digest,
          cliVersions: started,
        }),
      }),
      null,
    );
  }
});

test("a frozen-report stage ignores a Codex release it cannot have used", async (t) => {
  const start = { claude: "2.1.258", codex: "0.48.2" };
  const harness = makeHarness({
    laneCount: 1,
    cliVersions: { ...start, judge: start.claude },
  });
  t.after(harness.cleanup);
  const live = { ...start };
  const probes = [];
  const stderr = [];
  const written = t.mock.method(process.stderr, "write", (line) => {
    stderr.push(line);
    return true;
  });
  t.after(() => written.mock.restore());
  const result = await stageRun(harness, {
    stage: harness.stage,
    probe: (name) => {
      probes.push(name);
      const version = live[name];
      // Codex updates itself after the stage-start pair, while the arms run.
      // No cell of a frozen-report stage spawns the finder, so no cell can
      // have used it.
      if (probes.length >= 2) live.codex = "0.48.3";
      return version;
    },
  });
  assert.deepEqual(probes, ["claude", "codex", "claude"]);
  assert.deepEqual(stderr, []);
  assert.equal(result.runtime_change_during_stage, undefined);
  assert.equal(result.decision.runtime_change_during_stage, undefined);
  assert.equal(
    result.decision.reasons.some((reason) =>
      reason.startsWith("runtime changed during"),
    ),
    false,
  );
});

test("a live-paired stage names a Codex release its finder could have used", async (t) => {
  const start = { claude: "2.1.258", codex: "0.48.2" };
  const harness = makeHarness({
    laneCount: 1,
    live: true,
    cliVersions: { ...start, judge: start.claude },
  });
  t.after(harness.cleanup);
  const live = { ...start };
  const probes = [];
  const stderr = [];
  const written = t.mock.method(process.stderr, "write", (line) => {
    stderr.push(line);
    return true;
  });
  t.after(() => written.mock.restore());
  // A live-paired stage runs only after a promising holdout.
  seedStageResult(harness, "holdout", {
    records: [],
    decision: { status: "PROMISING", reasons: [] },
  });
  const result = await stageRun(harness, {
    stage: harness.stage,
    finderExec: async () => "one shared live finder report",
    probe: (name) => {
      probes.push(name);
      const version = live[name];
      // The same release, landing after the stage-start pair.
      if (probes.length >= 2) live.codex = "0.48.3";
      return version;
    },
  });
  // The stage spawns the finder, so its end-of-stage probe reads Codex too.
  assert.deepEqual(probes, ["claude", "codex", "claude", "codex"]);
  const change = {
    providers: [{ provider: "codex", start: "0.48.2", end: "0.48.3" }],
    summary: "codex 0.48.2 -> 0.48.3",
  };
  assert.deepEqual(result.runtime_change_during_stage, {
    "live-paired": change,
  });
  assert.equal(stderr.length, 1);
  assert.match(
    stderr[0],
    /runtime changed during the live-paired stage: codex 0\.48\.2 -> 0\.48\.3/,
  );
});

/** A judge that matches the candidate's claim and not the incumbent's. */
function pairedJudge() {
  return async ({ prompt }) => {
    const matched = prompt.includes("file.js:1 has a defect");
    if (prompt.startsWith("Below is a code review.")) {
      return JSON.stringify([
        matched ? "file.js:1 has a defect" : "file.js:2 could be tidier",
      ]);
    }
    if (prompt.startsWith("You are matching a code review")) {
      return JSON.stringify({
        matches: matched ? [1] : [],
        reasoning: matched ? { 1: "the review names the defect" } : {},
      });
    }
    if (prompt.startsWith("You are verifying claims")) {
      return JSON.stringify({
        verdicts: { 1: { class: "wrong", why: "the fixture disproves it" } },
      });
    }
    throw new Error("unexpected judge prompt");
  };
}

const pairedContestant = async ({ treatment }) =>
  contestantStream([
    treatment === "candidate"
      ? "file.js:1 has a defect"
      : "file.js:2 could be tidier",
  ]);

test("a holdout decision carries the change the screen recorded", async (t) => {
  const start = { claude: "2.1.258", codex: "0.48.2" };
  const harness = makeHarness({
    laneCount: 3,
    stage: "holdout",
    withScreen: true,
    cliVersions: { ...start, judge: start.claude },
  });
  t.after(harness.cleanup);
  const live = { ...start };
  let probes = 0;
  let updateMidStage = true;
  const probe = (name) => {
    probes += 1;
    const version = live[name];
    // Claude updates itself once the screen's arms are running.
    if (updateMidStage && probes >= 2) live.claude = "2.1.259";
    return version;
  };
  const screen = await stageRun(harness, {
    stage: "screen",
    probe,
    judgeExec: pairedJudge(),
    contestantExec: pairedContestant,
  });
  assert.equal(screen.decision.status, "PROMISING");
  const change = {
    providers: [
      { provider: "claude", start: "2.1.258", end: "2.1.259" },
      { provider: "judge", start: "2.1.258", end: "2.1.259" },
    ],
    summary: "claude 2.1.258 -> 2.1.259, judge 2.1.258 -> 2.1.259",
  };
  assert.deepEqual(screen.runtime_change_during_stage, { screen: change });

  // The holdout runs on a settled runtime, and folds in the screen records.
  updateMidStage = false;
  probes = 0;
  const holdout = await stageRun(harness, {
    stage: "holdout",
    probe,
    judgeExec: pairedJudge(),
    contestantExec: pairedContestant,
  });
  const reason =
    "runtime changed during the screen stage: claude 2.1.258 -> 2.1.259, " +
    "judge 2.1.258 -> 2.1.259; cells that ran after the change may have " +
    "used the later version and are keyed on the earlier one";
  // The combined decision reads the screen records, so it must keep what the
  // screen saw change while it ran.
  assert.deepEqual(holdout.runtime_change_during_stage, { screen: change });
  assert.deepEqual(holdout.decision.runtime_change_during_stage, {
    screen: change,
  });
  assert.equal(holdout.decision.reasons[0], reason);
  assert.deepEqual(Object.keys(holdout.records_by_stage).sort(), [
    "holdout",
    "screen",
  ]);
});

test("a judge upgrade between two runs reuses the contestant cell", async (t) => {
  const harness = makeHarness({ laneCount: 1 });
  t.after(harness.cleanup);
  const cliVersions = {
    claude: "claude-1",
    codex: "codex-1",
    judge: "judge-1",
  };
  const first = await runExperimentRuntimeStage(
    baseOptions(harness, { cliVersions }),
  );
  assert.deepEqual(first.records[0].cache_reuse, { raw: false, score: false });
  const second = await runExperimentRuntimeStage(
    baseOptions(harness, {
      cliVersions: { ...cliVersions, judge: "judge-2" },
      contestantExec: async () => {
        throw new Error("the contestant must not run again");
      },
    }),
  );
  // The raw phase never invokes the judge, so the transcript is reused and
  // only the judged phase is paid for again.
  assert.deepEqual(second.records[0].cache_reuse, { raw: true, score: false });
  assert.deepEqual(second.records[0].cli_versions, {
    raw: { claude: "claude-1" },
    score: { judge: "judge-2" },
  });
});
