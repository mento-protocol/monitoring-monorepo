// Novelty scoring for the non-ledger review-skill experiment lane.

import { scrubbedEnv } from "./review-eval-run-execution.mjs";
import { classifyNovel } from "./review-eval-score.mjs";
import { digestObject } from "./review-eval-experiment-contract.mjs";
import {
  experimentArtifactFile as artifactFile,
  experimentRecordCacheLineage as recordCacheLineage,
  readExperimentIdentityCache as readIdentityCache,
  writeExperimentCache as writeJsonOnce,
} from "./review-eval-experiment-cache.mjs";
import { buildCacheIdentity } from "./review-eval-experiment-evidence.mjs";
import {
  EXPERIMENT_CALL_TIMEOUT_MS,
  spawnExperimentProcess,
} from "./review-eval-experiment-process.mjs";
import {
  createDisposableExperimentFixture,
  createExperimentJudgeExec,
  disposeDisposableExperimentFixture,
  isolateExperimentCommand,
  verifyExperimentSandbox,
} from "./review-eval-experiment-isolation.mjs";

function safeModelEnv({ repoRoot }) {
  return scrubbedEnv({ roots: [repoRoot] });
}

function readPinnedTruth({ sourceSeal, lane }) {
  const truth = sourceSeal?.truth_by_pr?.[String(lane.pr)];
  if (!truth) throw new Error(`source seal has no truth for PR ${lane.pr}`);
  return truth;
}

/** Classify wrong claims only after the deterministic recall decision asks. */
export async function enrichRecordsWithNovelty({
  plan,
  candidateId,
  records,
  artifactRoot,
  repoRoot,
  fixtureCacheDir,
  sourceSeal,
  preparedFixtures = new Map(),
  calibrationReceipt,
  judgeExec: suppliedJudgeExec = null,
  concurrency = 3,
  timeoutMs = EXPERIMENT_CALL_TIMEOUT_MS,
  signal = null,
  beforeWrite = null,
  runCommand = spawnExperimentProcess,
  isolateCommand = isolateExperimentCommand,
  sandboxWorktreeRoots = null,
  createFixture = createDisposableExperimentFixture,
  disposeFixture = disposeDisposableExperimentFixture,
  sandboxProbe = null,
  deadlineMs = Number.POSITIVE_INFINITY,
}) {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 3
  ) {
    throw new Error("novelty fixture concurrency must be 1..3");
  }
  const env = safeModelEnv({ repoRoot });
  const protectedRoots = [
    plan.incumbent.skill_ref,
    ...plan.candidates.map((candidate) => candidate.skill_ref),
  ];
  const judgeExec =
    suppliedJudgeExec ??
    createExperimentJudgeExec({
      claudeFile: plan.identities.claude_bin.path,
      repoRoot,
      artifactRoot,
      fixtureCacheDir,
      env,
      timeoutMs,
      signal,
      runCommand,
      isolateCommand,
      worktreeRoots: sandboxWorktreeRoots,
      protectedRoots,
    });
  if (sourceSeal?.manifest?.plan_digest !== plan.plan_digest) {
    throw new Error("the experiment runtime source seal is missing or stale");
  }
  const byPr = new Map();
  for (const record of records) {
    byPr.set(record.pr, [...(byPr.get(record.pr) ?? []), record]);
  }
  const groups = [...byPr.entries()].sort(([left], [right]) => left - right);
  let next = 0;
  const output = new Array(groups.length);
  const workers = Array.from(
    { length: Math.min(concurrency, groups.length) },
    async () => {
      while (next < groups.length) {
        const index = next;
        next += 1;
        const [pr, own] = groups[index];
        const fixture = preparedFixtures.get(pr);
        if (!fixture) {
          throw new Error(
            `fixture PR ${pr} was not materialized before paid novelty scoring`,
          );
        }
        const updated = [];
        for (const record of own) {
          const { lane, raw, matched } = recordCacheLineage({
            plan,
            candidateId,
            record,
            artifactRoot,
            calibrationReceiptDigest: calibrationReceipt.receipt_digest,
          });
          const identity = buildCacheIdentity({
            phase: "novel",
            plan,
            candidateId,
            stage: record.stage,
            pr,
            treatment: record.treatment,
            finderArtifactDigest:
              lane.source.kind === "live-finder"
                ? raw.identity.source.finder_artifact_digest
                : null,
            rawDigest: record.raw_digest,
            matchDigest: record.match_digest,
            claimsDigest: record.claims_digest,
            calibrationReceiptDigest: calibrationReceipt.receipt_digest,
          });
          const novelFile = artifactFile(
            artifactRoot,
            `cache/novel/${identity.digest}.json`,
          );
          let novel = readIdentityCache(novelFile, identity, "novel_digest");
          if (!novel) {
            const active = createFixture({
              seedFixture: fixture,
              fixtureCacheDir,
              head: lane.fixture.first_head,
              base: lane.fixture.base_sha,
              cellId: `${record.cell_id}-novelty`,
              deadlineMs,
            });
            let verdict;
            try {
              if (isolateCommand === isolateExperimentCommand) {
                verifyExperimentSandbox({
                  repoRoot,
                  artifactRoot,
                  fixtureCacheDir,
                  fixturePath: active.path,
                  worktreeRoots: sandboxWorktreeRoots,
                  protectedRoots,
                });
              } else {
                sandboxProbe?.({ fixturePath: active.path, role: "novelty" });
              }
              const truth = readPinnedTruth({ sourceSeal, lane });
              beforeWrite?.();
              verdict = await classifyNovel({
                claims: matched.claims,
                matchedIds: matched.matched_ids,
                truthFindings: truth.findings,
                fixturePath: active.path,
                exec: judgeExec,
                model: plan.identities.judge.model,
                effort: plan.identities.judge.effort,
              });
            } finally {
              disposeFixture({
                fixturePath: active.path,
                fixtureCacheDir,
              });
            }
            const base = {
              schema_version: 1,
              namespace: plan.namespace,
              identity,
              verdict,
            };
            novel = { ...base, novel_digest: digestObject(base) };
            writeJsonOnce(novelFile, novel, beforeWrite);
          }
          updated.push({
            ...record,
            wrong_claims: novel.verdict.novelWrong,
            novel_real: novel.verdict.novelReal,
            novel_digest: novel.novel_digest,
            artifacts: { ...record.artifacts, novel: novelFile },
          });
        }
        output[index] = updated;
      }
    },
  );
  await Promise.all(workers);
  return output.flat();
}
