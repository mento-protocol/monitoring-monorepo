// Optional novel-claim classification for scored experiment cells.
//
// This phase runs only when claim inflation requires it or a candidate reaches
// the holdout finalist decision, so it stays out of the arm runtime.

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

/**
 * The planned lane one record came from. A PR now owns one lane per draw, so
 * the cell id is what identifies the lane; matching on the PR alone would
 * attribute a second draw's record to the first draw's lane and key its
 * novelty cell on the wrong draw.
 *
 * The record's own `pr` and `draw` are checked against that lane rather than
 * trusted. `pr` is the key this phase groups on, so a record whose `pr`
 * disagrees with its cell id would materialize one PR's fixture tree and
 * classify another PR's claims against it; `draw` keys the novelty cell, so a
 * record carrying the wrong one would write its verdict over the other draw's.
 * Both are refused instead of silently preferring the cell id.
 */
function laneForRecord(plan, record) {
  const lane = stagePlanFor({ plan, stage: record.stage }).lanes.find(
    (candidate) =>
      candidate.pr === record.pr &&
      record.cell_id === experimentCellId(candidate, record.treatment),
  );
  if (!lane) {
    throw new Error(`record ${record.cell_id} has no planned experiment lane`);
  }
  if ((record.draw ?? 0) !== (lane.draw ?? 0)) {
    throw new Error(
      `record ${record.cell_id} draw ${record.draw} is not the planned lane's`,
    );
  }
  return lane;
}

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
    const lane = laneForRecord(plan, record);
    // One materialized fixture serves every draw and both arms of a PR.
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
        const draw = recordLane.draw ?? 0;
        // A record's score artifact is keyed on the versions that produced it,
        // not on today's probe: a judge upgraded between a screen and its
        // holdout must still find the screen scores it recorded.
        const scoreIdentity = scoreCacheIdentity({
          plan,
          rawDigest: record.raw_digest,
          draw,
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
                draw,
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
            draw,
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
