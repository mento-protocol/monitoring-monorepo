// Paid runtime for the small non-ledger review-skill experiment.

import {
  claudeExec,
  resetFixture,
  scrubbedEnv,
} from "./review-eval-run-execution.mjs";
import {
  leakSignals,
  loginsInFixtureTree,
  reviewerLogins,
} from "./review-eval-run-cell.mjs";
import { finderArgvDigest } from "./review-eval-run-plan.mjs";
import {
  extractClaims,
  matchClaims,
  scorerDigest,
} from "./review-eval-score.mjs";
import {
  LANE_CONCURRENCY_MAX,
  rawCacheIdentity,
  scoreCacheIdentity,
  stagePlanFor,
} from "./review-eval-experiment-contract.mjs";
import { phaseCliVersions } from "./review-eval-experiment-versions.mjs";
import {
  assertExperimentConcurrency,
  assertExperimentScorer,
  defaultExperimentContestantExec,
  defaultExperimentFinderExec,
  defaultExperimentPrepareFixture,
  defaultExperimentTruth,
  experimentCellId,
  experimentContestantArgv,
  experimentModel,
  experimentProviderText,
  experimentTreatment,
  liveFinderHandoff,
  mapExperimentLimit,
  parseExperimentContestantEnvelope,
  purgeExperimentSkill,
  readPinnedExperimentFile,
  readExperimentCache,
  renderExperimentHandoff,
  resetExperimentFixture,
  stageExperimentSkill,
  validateRawExperimentPayload,
  validateScoreExperimentPayload,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";

export const parseContestantEnvelope = parseExperimentContestantEnvelope;
// The optional classification phase keeps its own module; both it and the
// scorer guard are re-exported here so the runtime stays one import for its
// callers.
export { assertExperimentScorer } from "./review-eval-experiment-cache.mjs";
export { enrichExperimentNovelty } from "./review-eval-experiment-novelty.mjs";

async function laneSource({
  plan,
  contract,
  lane,
  fixture,
  repoRoot,
  env,
  reset,
  finderExec,
}) {
  if (lane.source.kind === "frozen-report") {
    const text = readPinnedExperimentFile({
      repoRoot,
      record: lane.source,
      label: `PR ${lane.pr} frozen report`,
    });
    if (!text.trim()) throw new Error(`PR ${lane.pr} frozen report is empty`);
    return { kind: lane.source.kind, text, digest: lane.source.sha256 };
  }
  if (lane.source.kind !== "live-finder" || lane.source.shared !== true) {
    throw new Error(`PR ${lane.pr} has an invalid experiment source`);
  }
  const finderDigest = finderArgvDigest(contract);
  if (
    finderDigest !== plan.inputs.finder_argv_digest ||
    finderDigest !== lane.source.finder_argv_digest
  ) {
    throw new Error(`PR ${lane.pr} finder argv differs from the plan`);
  }
  await resetExperimentFixture({
    reset,
    fixture,
    lane,
    label: `${lane.lane_id}-finder`,
  });
  const raw = experimentProviderText(
    await finderExec({
      argv: contract.sut.finder.argv,
      cwd: fixture.path,
      env,
      lane,
      plan,
    }),
    "live finder",
  );
  const handoff = liveFinderHandoff(raw);
  if (!handoff.text.trim()) {
    throw new Error(`live finder returned no report for PR ${lane.pr}`);
  }
  return { kind: lane.source.kind, ...handoff };
}

export function createExperimentArmExecutor({
  plan,
  stage,
  contract,
  artifactRoot,
  repoRoot,
  cliVersions,
  handoffTemplate = readPinnedExperimentFile({
    repoRoot,
    record: plan.inputs.prompts.handoff,
    label: "handoff prompt",
  }),
  contestantExec = defaultExperimentContestantExec,
  judgeExec = claudeExec,
  reset = resetFixture,
  loadTruth = defaultExperimentTruth,
  readCache = readExperimentCache,
  writeCache = writeExperimentCache,
  scorerDigestNow = scorerDigest,
  env = scrubbedEnv({ roots: [repoRoot] }),
}) {
  const judge = (request) => judgeExec({ ...request, env });
  return async ({ lane, treatment, fixture, source }) => {
    const rawVersions = phaseCliVersions({
      phase: "raw",
      cliVersions,
      source,
    });
    const rawIdentity = rawCacheIdentity({
      plan,
      stage,
      lane,
      treatment,
      sourceDigest: source.digest,
      // The identity is keyed on the exact set this phase stores and
      // validates, so a judge upgrade cannot invalidate a contestant cell.
      phaseVersions: rawVersions,
    });
    let rawEntry = readCache({
      artifactRoot,
      kind: "raw",
      identity: rawIdentity,
    });
    const rawReused = rawEntry !== null;
    if (!rawEntry) {
      await resetExperimentFixture({
        reset,
        fixture,
        lane,
        label: experimentCellId(lane, treatment),
      });
      const selected = experimentTreatment(plan, treatment);
      const prompt = renderExperimentHandoff(handoffTemplate, source.text);
      const model = experimentModel(plan, "verifier");
      const systemPrompt = stageExperimentSkill({
        fixturePath: fixture.path,
        skill: selected,
      });
      let contestantOutput;
      try {
        contestantOutput = await contestantExec({
          argv: experimentContestantArgv({ prompt, model, systemPrompt }),
          prompt,
          systemPrompt,
          fixturePath: fixture.path,
          skill: selected,
          model,
          env,
          lane,
          treatment,
          plan,
        });
      } finally {
        purgeExperimentSkill(fixture.path);
      }
      const envelope = parseContestantEnvelope(contestantOutput);
      rawEntry = writeCache({
        artifactRoot,
        kind: "raw",
        identity: rawIdentity,
        payload: {
          ok: true,
          campaign_id: plan.campaign_id,
          candidate_id: plan.candidate.id,
          stage,
          cell_id: experimentCellId(lane, treatment),
          pr: lane.pr,
          treatment,
          // The runtime this transcript was produced under, stored with it.
          cli_versions: rawVersions,
          source_digest: source.digest,
          source_report: source.text,
          // Every assistant message of the cell that fits the judge budget, in
          // order — not the last one. The three counts are kept so a re-read of
          // the cache can tell a multi-message session from a single-message
          // one and see how much of the session `output` dropped, which is the
          // same evidence the canonical cell writer stores.
          output: envelope.result,
          assistant_messages: envelope.assistant_messages,
          assistant_messages_kept: envelope.assistant_messages_kept,
          stream_chars: envelope.stream_chars,
          cost_usd: Number(envelope.total_cost_usd ?? 0),
          turns: envelope.num_turns ?? null,
        },
      });
    }
    const raw = validateRawExperimentPayload(rawEntry.payload, {
      plan,
      stage,
      lane,
      treatment,
      source,
      cellId: experimentCellId(lane, treatment),
      cliVersions: rawVersions,
    });
    const rawDigest = rawEntry.artifact.content_digest;
    // An empty transcript is scored without a judge call, so this phase records
    // the empty provider set and a judge upgrade neither reruns it nor is
    // charged with its drift.
    const scoreVersions = phaseCliVersions({
      phase: "score",
      cliVersions,
      invokesJudge: raw.output.trim().length > 0,
    });
    const scoreIdentity = scoreCacheIdentity({
      plan,
      rawDigest,
      draw: lane.draw ?? 0,
      phaseVersions: scoreVersions,
    });
    let scoreEntry = readCache({
      artifactRoot,
      kind: "score",
      identity: scoreIdentity,
    });
    const scoreReused = scoreEntry !== null;
    if (!scoreEntry) {
      const truth = await loadTruth({ repoRoot, lane, contract });
      let claims = [];
      let matches = { matchedIds: [], judgeReasoning: {} };
      if (raw.output.trim()) {
        await resetExperimentFixture({
          reset,
          fixture,
          lane,
          label: `${experimentCellId(lane, treatment)}-extract`,
        });
        assertExperimentScorer(plan, scorerDigestNow);
        claims = await extractClaims({
          transcript: raw.output,
          exec: judge,
          ...experimentModel(plan, "judge"),
        });
        await resetExperimentFixture({
          reset,
          fixture,
          lane,
          label: `${experimentCellId(lane, treatment)}-match`,
        });
        assertExperimentScorer(plan, scorerDigestNow);
        matches = await matchClaims({
          claims,
          truthFindings: truth.findings,
          scorableIds: lane.fixture.scorable_ids,
          transcript: raw.output,
          exec: judge,
          ...experimentModel(plan, "judge"),
        });
      }
      await resetExperimentFixture({
        reset,
        fixture,
        lane,
        label: `${experimentCellId(lane, treatment)}-leak`,
      });
      const excluded = loginsInFixtureTree({
        fixturePath: fixture.path,
        logins: reviewerLogins(truth),
      });
      const leak = leakSignals({
        transcript: raw.output,
        truth,
        pr: lane.pr,
        excludeLogins: excluded,
        forbiddenShas: fixture.forbidden ?? [],
      });
      assertExperimentScorer(plan, scorerDigestNow);
      scoreEntry = writeCache({
        artifactRoot,
        kind: "score",
        identity: scoreIdentity,
        payload: {
          raw_digest: rawDigest,
          // The judge runtime that extracted and matched these claims.
          cli_versions: scoreVersions,
          claims,
          matched_ids: matches.matchedIds,
          judge_reasoning: matches.judgeReasoning,
          leak,
        },
      });
    }
    const score = validateScoreExperimentPayload(
      scoreEntry.payload,
      rawDigest,
      scoreVersions,
      experimentCellId(lane, treatment),
    );
    return {
      ok: true,
      campaign_id: plan.campaign_id,
      candidate_id: plan.candidate.id,
      stage,
      cell_id: experimentCellId(lane, treatment),
      pr: lane.pr,
      draw: lane.draw ?? 0,
      treatment,
      output: raw.output,
      // How much of the session `output` carries, beside the text itself.
      assistant_messages: raw.assistant_messages,
      assistant_messages_kept: raw.assistant_messages_kept,
      stream_chars: raw.stream_chars,
      claims: score.claims,
      claims_count: score.claims.length,
      matched_ids: score.matched_ids,
      leak: score.leak,
      empty: raw.output.trim().length === 0,
      // Read from the artifacts, so a reused artifact reports the runtime that
      // produced it rather than the runtime of this invocation.
      cli_versions: { raw: raw.cli_versions, score: score.cli_versions },
      raw_digest: rawDigest,
      score_digest: scoreEntry.artifact.content_digest,
      cache_reuse: { raw: rawReused, score: scoreReused },
      artifacts: { raw: rawEntry.file, score: scoreEntry.file },
    };
  };
}

/**
 * The stage's lanes grouped by PR, each group in its planned order.
 *
 * One materialized fixture directory serves every lane of a PR: the cache is
 * keyed on the PR and its head, not on the lane. Each cell resets that tree and
 * stages `.skill/` inside it, so two draws of one PR running at the same time
 * would delete each other's working tree. A group therefore runs strictly in
 * sequence, and only whole groups — separate trees — run concurrently.
 */
function laneGroups(lanes) {
  const groups = new Map();
  for (const lane of lanes) {
    const group = groups.get(lane.pr);
    if (group) group.push(lane);
    else groups.set(lane.pr, [lane]);
  }
  return [...groups.values()];
}

export async function runExperimentRuntimeStage({
  plan,
  stage,
  contract,
  artifactRoot,
  repoRoot,
  fixtureCacheDir,
  concurrency = LANE_CONCURRENCY_MAX,
  prepareFixture = defaultExperimentPrepareFixture,
  finderExec = defaultExperimentFinderExec,
  reset = resetFixture,
  ...armOptions
}) {
  assertExperimentConcurrency(concurrency);
  const stagePlan = stagePlanFor({ plan, stage });
  if (stagePlan.enabled !== true) {
    throw new Error(`experiment stage ${stage} is disabled`);
  }
  // The lane count is the grid times the draws. Only how many PRs run at once
  // is capped; a wider panel costs wall time, not correctness.
  if (!Array.isArray(stagePlan.lanes) || stagePlan.lanes.length === 0) {
    throw new Error(`experiment stage ${stage} plans no fixture lane`);
  }
  const env = armOptions.env ?? scrubbedEnv({ roots: [repoRoot] });
  const executeArm = createExperimentArmExecutor({
    plan,
    stage,
    contract,
    artifactRoot,
    repoRoot,
    reset,
    env,
    ...armOptions,
  });
  const materialize = (lane) =>
    prepareFixture({ plan, stage, contract, lane, fixtureCacheDir, repoRoot });
  const groupRuns = await mapExperimentLimit(
    laneGroups(stagePlan.lanes),
    concurrency,
    async (group) => {
      // One source per PR group. On a live-paired stage the finder runs once
      // for the PR and every draw and both arms read that identical report, so
      // a difference between two draws is verifier variance and never a second
      // finder output.
      const source = await laneSource({
        plan,
        contract,
        lane: group[0],
        fixture: await materialize(group[0]),
        repoRoot,
        env,
        reset,
        finderExec,
      });
      const runs = [];
      for (const lane of group) {
        const fixture = await materialize(lane);
        const records = [];
        for (const treatment of lane.sequence) {
          records.push(await executeArm({ lane, treatment, fixture, source }));
        }
        runs.push({
          lane_id: lane.lane_id,
          pr: lane.pr,
          draw: lane.draw ?? 0,
          paired_order: lane.paired_order,
          sequence: [...lane.sequence],
          records,
        });
      }
      return runs;
    },
  );
  // Groups are built in first-appearance order and concatenated, so the lane
  // and record order is the plan's own.
  const laneRuns = groupRuns.flat();
  return {
    campaign_id: plan.campaign_id,
    candidate_id: plan.candidate.id,
    stage,
    concurrency,
    lanes: laneRuns.map(({ records: _records, ...lane }) => lane),
    records: laneRuns.flatMap((lane) => lane.records),
  };
}
