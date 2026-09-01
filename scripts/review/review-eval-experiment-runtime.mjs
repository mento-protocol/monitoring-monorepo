// Live model runtime for the non-ledger review-skill experiment lane.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  fixtureForPr,
  forbiddenShasForFixture,
} from "./review-eval-fixtures.mjs";
import { scrubbedEnv } from "./review-eval-run-execution.mjs";
import {
  leakSignals,
  loginsInFixtureTree,
  reviewerLogins,
} from "./review-eval-run-cell.mjs";
import { extractClaims, matchClaims } from "./review-eval-score.mjs";
import { digestObject } from "./review-eval-experiment-contract.mjs";
import {
  experimentArtifactFile as artifactFile,
  readExperimentIdentityCache as readIdentityCache,
  validateExperimentRecordCaches,
  writeExperimentCache as writeJsonOnce,
} from "./review-eval-experiment-cache.mjs";
import { buildCacheIdentity } from "./review-eval-experiment-evidence.mjs";
import {
  EXPERIMENT_CALL_TIMEOUT_MS,
  claudeStdinArgv,
  spawnExperimentProcess,
} from "./review-eval-experiment-process.mjs";
import {
  ensureExperimentCalibration,
  prepareExperimentFixtures,
} from "./review-eval-experiment-prepare.mjs";
import {
  createDisposableExperimentFixture,
  createExperimentJudgeExec,
  disposeDisposableExperimentFixture,
  isolateExperimentCommand,
  registeredExperimentWorktrees,
  verifyExperimentSandbox,
} from "./review-eval-experiment-isolation.mjs";
import {
  ensureLiveFinderReceipt,
  liveFinderHandoff,
} from "./review-eval-experiment-finder.mjs";
import {
  capturedSkillDigest,
  stageExperimentSkill,
} from "./review-eval-experiment-seal.mjs";

export {
  ensureExperimentCalibration,
  prepareExperimentFixtures,
  validateExperimentRecordCaches,
  liveFinderHandoff,
};
export { enrichRecordsWithNovelty } from "./review-eval-experiment-novelty.mjs";

const CONTESTANT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "Agent",
  "TodoWrite",
];
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function treatmentFor(plan, candidateId, treatment) {
  if (treatment === "incumbent") return plan.incumbent;
  const found = plan.candidates.find(
    (candidate) => candidate.id === candidateId,
  );
  if (!found) throw new Error(`plan has no candidate ${candidateId}`);
  return found;
}

function parseContestantEnvelope(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    throw new Error(`contestant returned no JSON envelope: ${error.message}`, {
      cause: error,
    });
  }
  if (
    envelope?.is_error === true ||
    typeof envelope?.result !== "string" ||
    envelope.result.trim().length === 0
  ) {
    throw new Error("contestant returned no usable review text");
  }
  return envelope;
}

function safeModelEnv({ repoRoot }) {
  return scrubbedEnv({ roots: [repoRoot] });
}

function readPinnedTruth({ sourceSeal, lane }) {
  const truth = sourceSeal?.truth_by_pr?.[String(lane.pr)];
  if (!truth) throw new Error(`source seal has no truth for PR ${lane.pr}`);
  return truth;
}

function frozenFinderReport({ sourceSeal, lane }) {
  const text = sourceSeal?.finder_reports?.[lane.source.file];
  if (typeof text !== "string") {
    throw new Error(`source seal has no finder report for PR ${lane.pr}`);
  }
  if (!text.trim())
    throw new Error(`frozen finder report is empty for PR ${lane.pr}`);
  return text;
}

function renderHandoff({ sourceSeal, otherReview }) {
  return sourceSeal.handoff_template.replace(
    "{{OTHER_REVIEW}}",
    () => otherReview,
  );
}

/** Build the live arm function passed to runExperimentStage. */
export function createExperimentArmExecutor({
  plan,
  contract,
  artifactRoot,
  repoRoot,
  fixtureCacheDir,
  sourceSeal,
  preparedFixtures = new Map(),
  calibrationReceipt,
  timeoutMs = EXPERIMENT_CALL_TIMEOUT_MS,
  runCommand = spawnExperimentProcess,
  judgeExec: suppliedJudgeExec = null,
  signal = null,
  beforeWrite = null,
  isolateCommand = isolateExperimentCommand,
  sandboxWorktreeRoots = null,
  createFixture = createDisposableExperimentFixture,
  disposeFixture = disposeDisposableExperimentFixture,
  sandboxProbe = null,
  deadlineMs = Number.POSITIVE_INFINITY,
}) {
  if (calibrationReceipt?.receipt_digest == null) {
    throw new Error("a calibration receipt is required before scoring");
  }
  if (sourceSeal?.manifest?.plan_digest !== plan.plan_digest) {
    throw new Error("the experiment runtime source seal is missing or stale");
  }
  const fixtureCache = new Map(preparedFixtures);
  const liveReports = new Map();
  const env = safeModelEnv({ repoRoot });
  const protectedRoots = [
    plan.incumbent.skill_ref,
    ...plan.candidates.map((candidate) => candidate.skill_ref),
  ];
  let worktreeRoots = sandboxWorktreeRoots;
  const isolatedCommand = ({ file, args, fixturePath }) => {
    if (worktreeRoots === null && isolateCommand === isolateExperimentCommand) {
      worktreeRoots = registeredExperimentWorktrees({ repoRoot });
    }
    return isolateCommand({
      file,
      args,
      repoRoot,
      artifactRoot,
      fixtureCacheDir,
      fixturePath,
      worktreeRoots,
      protectedRoots,
    });
  };
  const withDisposableFixture = async ({
    seedFixture,
    head,
    base,
    cellId,
    role,
    run,
  }) => {
    const active = createFixture({
      seedFixture,
      fixtureCacheDir,
      head,
      base,
      cellId: `${cellId}-${role}`,
      deadlineMs,
    });
    try {
      if (isolateCommand === isolateExperimentCommand) {
        verifyExperimentSandbox({
          repoRoot,
          artifactRoot,
          fixtureCacheDir,
          fixturePath: active.path,
          worktreeRoots,
          protectedRoots,
        });
      } else {
        sandboxProbe?.({ fixturePath: active.path, role });
      }
      return await run(active);
    } finally {
      disposeFixture({ fixturePath: active.path, fixtureCacheDir });
    }
  };
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
      isolateCommand: isolatedCommand,
      worktreeRoots,
      protectedRoots,
    });

  const fixtureReport = (pr) => {
    if (!fixtureCache.has(pr)) {
      throw new Error(
        `fixture PR ${pr} was not materialized before paid execution`,
      );
    }
    return fixtureCache.get(pr);
  };

  const otherReview = async ({ lane }) => {
    if (lane.source.kind === "frozen-replay") {
      const text = frozenFinderReport({ sourceSeal, lane });
      return { text, digest: sha256(text) };
    }
    if (!liveReports.has(lane.lane_id)) {
      liveReports.set(
        lane.lane_id,
        ensureLiveFinderReceipt({
          plan,
          contract,
          lane,
          artifactRoot,
          fixture: fixtureReport(lane.pr),
          env,
          timeoutMs,
          signal,
          beforeWrite,
          runCommand,
          isolatedCommand,
          withDisposableFixture,
        }),
      );
    }
    return liveReports.get(lane.lane_id);
  };

  return async ({ candidateId, stage, attempt, lane, arm }) => {
    const finder = await otherReview({ lane });
    const rawIdentity = buildCacheIdentity({
      phase: "raw",
      plan,
      candidateId,
      stage,
      pr: lane.pr,
      treatment: arm.treatment,
      finderArtifactDigest:
        lane.source.kind === "live-finder" ? finder.digest : null,
    });
    const rawFile = artifactFile(
      artifactRoot,
      `cache/raw/${rawIdentity.digest}.json`,
    );
    let raw = readIdentityCache(rawFile, rawIdentity, "raw_digest");
    const rawReused = raw !== null;
    if (!raw) {
      const fixture = fixtureReport(lane.pr);
      const selected = treatmentFor(plan, candidateId, arm.treatment);
      const snapshot = sourceSeal.skill_snapshots[selected.id];
      if (
        snapshot?.digest !== selected.skill_digest ||
        capturedSkillDigest(snapshot.files ?? []) !== selected.skill_digest
      ) {
        throw new Error(`${selected.id} sealed skill snapshot changed`);
      }
      const prompt = renderHandoff({
        sourceSeal,
        otherReview: finder.text,
      });
      const started = Date.now();
      const response = await withDisposableFixture({
        seedFixture: fixture,
        head: lane.fixture.first_head,
        base: lane.fixture.base_sha,
        cellId: arm.canonical_cell_id,
        role: arm.treatment,
        run: async (active) => {
          const preamble = stageExperimentSkill({
            fixturePath: active.path,
            snapshot,
          });
          const preambleFile = path.join(
            active.path,
            ".skill",
            "experiment-system-prompt.txt",
          );
          writeFileSync(preambleFile, preamble, { mode: 0o600 });
          beforeWrite?.();
          const isolated = isolatedCommand({
            file: plan.identities.claude_bin.path,
            args: [
              ...claudeStdinArgv({
                prompt,
                model: contract.sut.verifier.model,
                effort: contract.sut.verifier.effort,
                allowedTools: CONTESTANT_TOOLS,
                maxTurns: 80,
              }),
              "--append-system-prompt-file",
              preambleFile,
            ],
            fixturePath: active.path,
          });
          return runCommand({
            ...isolated,
            cwd: active.path,
            env,
            input: prompt,
            timeoutMs,
            signal,
          });
        },
      });
      const envelope = parseContestantEnvelope(response.stdout);
      const base = {
        schema_version: 1,
        namespace: plan.namespace,
        identity: rawIdentity,
        campaign_id: plan.campaign_id,
        comparison_id: rawIdentity.comparison_id,
        stage,
        attempt,
        cell_id: arm.canonical_cell_id,
        pr: lane.pr,
        treatment: arm.treatment,
        condition: lane.source.kind === "live-finder" ? "pipeline" : "replay",
        draw: lane.source.draw ?? 1,
        model: contract.sut.verifier.model,
        effort: contract.sut.verifier.effort,
        finder: `${contract.sut.finder.model}@${contract.sut.finder.effort}`,
        fixture_head: lane.fixture.first_head,
        fingerprint: arm.execution_fingerprint,
        ok: true,
        output: envelope.result,
        other_review: finder.text,
        finder_chars: finder.text.length,
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        cost_usd: Number(envelope.total_cost_usd ?? 0),
        turns: envelope.num_turns ?? null,
      };
      raw = { ...base, raw_digest: digestObject(base) };
      writeJsonOnce(rawFile, raw, beforeWrite);
    }

    const matchIdentity = buildCacheIdentity({
      phase: "match",
      plan,
      candidateId,
      stage,
      pr: lane.pr,
      treatment: arm.treatment,
      finderArtifactDigest:
        lane.source.kind === "live-finder" ? finder.digest : null,
      rawDigest: raw.raw_digest,
      calibrationReceiptDigest: calibrationReceipt.receipt_digest,
    });
    const matchFile = artifactFile(
      artifactRoot,
      `cache/match/${matchIdentity.digest}.json`,
    );
    let matched = readIdentityCache(matchFile, matchIdentity, "match_digest");
    const matchReused = matched !== null;
    if (!matched) {
      const fixture = fixtureReport(lane.pr);
      const fixtureContract = fixtureForPr(contract, lane.pr);
      const truth = readPinnedTruth({ sourceSeal, lane });
      beforeWrite?.();
      const claims = await extractClaims({
        transcript: raw.output,
        exec: judgeExec,
        model: plan.identities.judge.model,
        effort: plan.identities.judge.effort,
      });
      beforeWrite?.();
      const matches = await matchClaims({
        claims,
        truthFindings: truth.findings,
        scorableIds: lane.fixture.scorable_ids,
        transcript: raw.output,
        exec: judgeExec,
        model: plan.identities.judge.model,
        effort: plan.identities.judge.effort,
      });
      const excludeLogins = [
        ...loginsInFixtureTree({
          fixturePath: fixture.path,
          logins: reviewerLogins(truth),
        }),
      ];
      const leak = leakSignals({
        transcript: raw.output,
        truth,
        pr: lane.pr,
        excludeLogins,
        forbiddenShas: forbiddenShasForFixture({
          fixture: fixtureContract,
          repoRoot,
          truth,
        }),
      });
      const base = {
        schema_version: 1,
        namespace: plan.namespace,
        identity: matchIdentity,
        raw_digest: raw.raw_digest,
        claims,
        claims_digest: digestObject(claims),
        matched_ids: matches.matchedIds,
        judge_reasoning: matches.judgeReasoning,
        leak,
      };
      matched = { ...base, match_digest: digestObject(base) };
      writeJsonOnce(matchFile, matched, beforeWrite);
    }
    return {
      ok: true,
      campaign_id: plan.campaign_id,
      candidate_id: candidateId,
      stage,
      attempt,
      cell_id: arm.canonical_cell_id,
      fingerprint: raw.fingerprint,
      pr: lane.pr,
      treatment: arm.treatment,
      output: raw.output,
      raw_digest: raw.raw_digest,
      match_digest: matched.match_digest,
      claims_digest: matched.claims_digest,
      claims_count: matched.claims.length,
      matched_ids: matched.matched_ids,
      leak: matched.leak,
      empty: matched.claims.length === 0,
      cache_reuse: { raw: rawReused, match: matchReused },
      artifacts: { raw: rawFile, match: matchFile },
    };
  };
}
