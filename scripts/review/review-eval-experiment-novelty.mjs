// The optional novelty phase of the experiment lane.
//
// It runs after a stage's cells are scored, so it is a separate pass over
// finished records rather than part of the paired run: only a decision that
// reaches the wrong-claim rule pays for it.

import {
  claudeExec,
  resetFixture,
  scrubbedEnv,
} from "./review-eval-run-execution.mjs";
import { classifyNovel, scorerDigest } from "./review-eval-score.mjs";
import {
  LANE_CONCURRENCY_MAX,
  novelCacheIdentity,
  scoreCacheIdentity,
  stagePlanFor,
} from "./review-eval-experiment-contract.mjs";
import {
  phaseCliVersions,
  recordedPhaseCliVersions,
} from "./review-eval-experiment-versions.mjs";
import {
  assertExperimentConcurrency,
  assertExperimentScorer,
  defaultExperimentPrepareFixture,
  defaultExperimentTruth,
  experimentCellId,
  experimentModel,
  mapExperimentLimit,
  readExperimentCache,
  resetExperimentFixture,
  validateNovelExperimentPayload,
  validateScoreExperimentPayload,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";

export async function enrichExperimentNovelty({
  plan,
  records,
  contract,
  artifactRoot,
  repoRoot,
  cliVersions,
  fixtureCacheDir,
  concurrency = LANE_CONCURRENCY_MAX,
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
    // A PR carries one lane per draw, so the cell id — not the PR — names the
    // lane a record belongs to.
    const lane = stagePlanFor({ plan, stage: record.stage }).lanes.find(
      (candidate) =>
        experimentCellId(candidate, record.treatment) === record.cell_id,
    );
    if (!lane) {
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
          draw: recordLane.draw ?? 0,
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
          record.cell_id,
        );
        // A record already enriched under an earlier runtime keeps that
        // artifact; only a novelty verdict written now carries the live judge.
        let identity =
          record.cli_versions?.novel === undefined
            ? null
            : novelCacheIdentity({
                plan,
                scoreDigest: record.score_digest,
                draw: recordLane.draw ?? 0,
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
            draw: recordLane.draw ?? 0,
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
          record.cell_id,
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
