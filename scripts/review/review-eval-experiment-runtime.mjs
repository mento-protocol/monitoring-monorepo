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
  classifyNovel,
  extractClaims,
  matchClaims,
  scorerDigest,
} from "./review-eval-score.mjs";
import {
  MAX_FIXTURE_LANES,
  novelCacheIdentity,
  phaseCliVersions,
  rawCacheIdentity,
  recordedPhaseCliVersions,
  scoreCacheIdentity,
  stagePlanFor,
} from "./review-eval-experiment-contract.mjs";
import {
  assertExperimentConcurrency,
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
  validateNovelExperimentPayload,
  validateRawExperimentPayload,
  validateScoreExperimentPayload,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";

export const parseContestantEnvelope = parseExperimentContestantEnvelope;

export function assertExperimentScorer(plan, scorerDigestNow = scorerDigest) {
  const current = scorerDigestNow();
  if (current !== plan.inputs.scorer_digest) {
    throw new Error(
      `experiment plan uses scorer ${plan.inputs.scorer_digest.slice(0, 8)}; ` +
        `the current scorer is ${current.slice(0, 8)}; re-plan before scoring`,
    );
  }
  return current;
}

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
      cliVersions,
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
          // Every assistant message of the cell, in order — not the last one.
          // `assistant_messages` is kept so a re-read of the cache can tell a
          // multi-message session from a single-message one.
          output: envelope.result,
          assistant_messages: envelope.assistant_messages,
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
    );
    return {
      ok: true,
      campaign_id: plan.campaign_id,
      candidate_id: plan.candidate.id,
      stage,
      cell_id: experimentCellId(lane, treatment),
      pr: lane.pr,
      treatment,
      output: raw.output,
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

export async function runExperimentRuntimeStage({
  plan,
  stage,
  contract,
  artifactRoot,
  repoRoot,
  fixtureCacheDir,
  concurrency = MAX_FIXTURE_LANES,
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
  if (
    !Array.isArray(stagePlan.lanes) ||
    stagePlan.lanes.length > MAX_FIXTURE_LANES
  ) {
    throw new Error(`experiment stage ${stage} exceeds three fixture lanes`);
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
  const laneRuns = await mapExperimentLimit(
    stagePlan.lanes,
    concurrency,
    async (lane) => {
      const fixture = await prepareFixture({
        plan,
        stage,
        contract,
        lane,
        fixtureCacheDir,
        repoRoot,
      });
      const source = await laneSource({
        plan,
        contract,
        lane,
        fixture,
        repoRoot,
        env,
        reset,
        finderExec,
      });
      const records = [];
      for (const treatment of lane.sequence) {
        records.push(await executeArm({ lane, treatment, fixture, source }));
      }
      return {
        lane_id: lane.lane_id,
        pr: lane.pr,
        paired_order: lane.paired_order,
        sequence: [...lane.sequence],
        records,
      };
    },
  );
  return {
    campaign_id: plan.campaign_id,
    candidate_id: plan.candidate.id,
    stage,
    concurrency,
    lanes: laneRuns.map(({ records: _records, ...lane }) => lane),
    records: laneRuns.flatMap((lane) => lane.records),
  };
}

export async function enrichExperimentNovelty({
  plan,
  records,
  contract,
  artifactRoot,
  repoRoot,
  cliVersions,
  fixtureCacheDir,
  concurrency = MAX_FIXTURE_LANES,
  prepareFixture = defaultExperimentPrepareFixture,
  judgeExec = claudeExec,
  reset = resetFixture,
  loadTruth = defaultExperimentTruth,
  readCache = readExperimentCache,
  writeCache = writeExperimentCache,
  scorerDigestNow = scorerDigest,
  env = scrubbedEnv({ roots: [repoRoot] }),
}) {
  assertExperimentConcurrency(concurrency);
  const groups = new Map();
  for (const record of records) {
    const lane = stagePlanFor({ plan, stage: record.stage }).lanes.find(
      (candidate) => candidate.pr === record.pr,
    );
    if (!lane || record.cell_id !== experimentCellId(lane, record.treatment)) {
      throw new Error(
        `record ${record.cell_id} has no planned experiment lane`,
      );
    }
    const key = String(record.pr);
    if (!groups.has(key)) groups.set(key, { lane, records: [] });
    groups.get(key).records.push({ lane, record });
  }
  const judge = (request) => judgeExec({ ...request, env });
  const enrichedGroups = await mapExperimentLimit(
    [...groups.values()],
    concurrency,
    async ({ lane, records: laneRecords }) => {
      const fixture = await prepareFixture({
        plan,
        stage: laneRecords[0].record.stage,
        contract,
        lane,
        fixtureCacheDir,
        repoRoot,
      });
      const truth = await loadTruth({ repoRoot, lane, contract });
      const enriched = [];
      for (const { lane: recordLane, record } of laneRecords) {
        // A record's score artifact is keyed on the versions that produced it,
        // not on today's probe: a judge upgraded between a screen and its
        // holdout must still find the screen scores it recorded.
        const scoreIdentity = scoreCacheIdentity({
          plan,
          rawDigest: record.raw_digest,
          phaseVersions: recordedPhaseCliVersions({ record, phase: "score" }),
        });
        const scoreEntry = readCache({
          artifactRoot,
          kind: "score",
          identity: scoreIdentity,
        });
        if (
          !scoreEntry ||
          scoreEntry.artifact.content_digest !== record.score_digest
        ) {
          throw new Error(
            `${record.cell_id} score cache differs from its record`,
          );
        }
        const score = validateScoreExperimentPayload(
          scoreEntry.payload,
          record.raw_digest,
          scoreIdentity.cli_versions,
        );
        // A record already enriched under an earlier runtime keeps that
        // artifact; only a novelty verdict written now carries the live judge.
        let identity =
          record.cli_versions?.novel === undefined
            ? null
            : novelCacheIdentity({
                plan,
                scoreDigest: record.score_digest,
                phaseVersions: recordedPhaseCliVersions({
                  record,
                  phase: "novel",
                }),
              });
        let entry = identity
          ? readCache({ artifactRoot, kind: "novel", identity })
          : null;
        if (!entry) {
          // `classifyNovel` returns without a judge call when no claim has
          // text, so such a cell records the empty provider set.
          identity = novelCacheIdentity({
            plan,
            scoreDigest: record.score_digest,
            phaseVersions: phaseCliVersions({
              phase: "novel",
              cliVersions,
              invokesJudge: score.claims.some(
                (claim) => claim.trim().length > 0,
              ),
            }),
          });
          entry = readCache({ artifactRoot, kind: "novel", identity });
        }
        const reused = entry !== null;
        if (!entry) {
          await resetExperimentFixture({
            reset,
            fixture,
            lane: recordLane,
            label: `${record.cell_id}-novel`,
          });
          assertExperimentScorer(plan, scorerDigestNow);
          const verdict = await classifyNovel({
            claims: score.claims,
            matchedIds: score.matched_ids,
            truthFindings: truth.findings,
            exec: judge,
            fixturePath: fixture.path,
            ...experimentModel(plan, "judge"),
          });
          assertExperimentScorer(plan, scorerDigestNow);
          entry = writeCache({
            artifactRoot,
            kind: "novel",
            identity,
            payload: {
              score_digest: record.score_digest,
              // The judge runtime that classified these claims, or the empty
              // set when the classification needed no judge.
              cli_versions: identity.cli_versions,
              verdict,
            },
          });
        }
        const payload = validateNovelExperimentPayload(
          entry.payload,
          record.score_digest,
          identity.cli_versions,
        );
        enriched.push({
          ...record,
          wrong_claims: payload.verdict.novelWrong,
          novel_real: payload.verdict.novelReal,
          cli_versions: { ...record.cli_versions, novel: payload.cli_versions },
          novel_digest: entry.artifact.content_digest,
          cache_reuse: { ...record.cache_reuse, novel: reused },
          artifacts: { ...record.artifacts, novel: entry.file },
        });
      }
      return enriched;
    },
  );
  return enrichedGroups.flat();
}
