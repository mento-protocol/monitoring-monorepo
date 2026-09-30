// Paired direct-review execution. Raw identities exclude labels and graders.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture, canonicalPath } from "./review-eval-fixtures.mjs";
import { resetFixture } from "./review-eval-run-execution.mjs";
import { parseClaudeStream } from "./review-eval-stream.mjs";
import { leakSignals } from "./review-eval-run-cell.mjs";
import { skillDigest } from "./review-eval-run-plan.mjs";
import { digestObject } from "./review-eval-experiment-contract.mjs";
import {
  stageExperimentSkill,
  purgeExperimentSkill,
  readExperimentCache,
  writeExperimentCache,
  sha256Bytes,
} from "./review-eval-experiment-cache.mjs";
import {
  loadDataset,
  verifyCaseProbes,
  rootsForCase,
} from "./review-eval-v2-dataset.mjs";
import { scoreReview, scorerDigestV2 } from "./review-eval-v2-score.mjs";
import { createProvider, writeJson } from "./review-eval-v2-provider.mjs";
import { metricSummary } from "./review-eval-v2-report.mjs";

export const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const PROMPT = "scripts/review/prompts/v2/request.md";
const EXECUTION_FILES = [
  "scripts/review/review-eval-v2-runner.mjs",
  "scripts/review/review-eval-v2-provider.mjs",
  "scripts/review/review-eval-run-execution.mjs",
  "scripts/review/review-eval-stream.mjs",
  "scripts/review/review-eval-experiment-cache.mjs",
  "scripts/review/review-eval-fixtures.mjs",
  "scripts/review/build-fixture.sh",
  "scripts/review/review-eval-run-plan.mjs",
  "scripts/review/review-eval-run-cell.mjs",
];
const digestFiles = (files) =>
  digestObject(
    files.map((file) => [
      file,
      sha256Bytes(readFileSync(path.join(REPO_ROOT, file))),
    ]),
  );
const keyed = (value) => ({ ...value, digest: digestObject(value) });
export const providerVersion = () =>
  execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();

const gitText = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
export function sourceState(cwd) {
  return digestObject({
    head: gitText(cwd, ["rev-parse", "HEAD"]),
    base: gitText(cwd, ["rev-parse", "base"]),
    diff: gitText(cwd, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
    ]),
    untracked: gitText(cwd, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter((file) => file && !file.startsWith(".skill/"))
      .map((file) => [file, sha256Bytes(readFileSync(path.join(cwd, file)))]),
  });
}
function sourceDiff(cwd) {
  const diff = gitText(cwd, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "base",
    "--",
  ]);
  if (diff.length > 120_000)
    throw new Error(
      "fixture diff exceeds 120000 characters; no text was truncated",
    );
  return diff;
}

export function executionIdentity({ plan, fixture, treatment }) {
  return keyed({
    namespace: "review-eval-v2",
    phase: "raw",
    protocol: "final-consolidated-v1",
    draw: 0,
    case_id: fixture.id,
    treatment,
    head: fixture.first_head,
    base: fixture.base_sha,
    forbidden_shas: fixture.forbidden_shas ?? [],
    repair_sha256: fixture.repair?.sha256 ?? null,
    skill_digest: plan.skills[treatment].skill_digest,
    model: plan.model,
    effort: plan.effort,
    cli_version: plan.cli_version,
    prompt_sha256: plan.prompt_sha256,
    execution_digest: plan.execution_digest,
    source: "direct-review",
    tools: ["Read", "Grep", "Glob"],
    max_turns: 60,
    billing_mode: plan.billing_mode,
    reviewer_cap_usd: null,
  });
}

export function scoringIdentity({
  rawDigest,
  datasetDigest,
  scorerDigest,
  model,
  effort,
  version,
}) {
  return keyed({
    namespace: "review-eval-v2",
    phase: "score",
    raw_digest: rawDigest,
    dataset_digest: datasetDigest,
    scorer_digest: scorerDigest,
    model,
    effort,
    cli_version: version,
  });
}

export function makePlan({
  datasetFile,
  incumbent,
  candidate,
  out,
  budget,
  model = "claude-opus-5",
  effort = "high",
}) {
  const root = canonicalPath(out);
  if (root === REPO_ROOT || root.startsWith(`${REPO_ROOT}${path.sep}`))
    throw new Error("artifacts must be outside repository");
  if (budget !== undefined)
    throw new Error(
      "--budget is retired; subscription runs have no dollar stop",
    );
  const loaded = loadDataset({ file: path.resolve(datasetFile) });
  const skills = Object.fromEntries(
    Object.entries({ incumbent, candidate }).map(([id, file]) => {
      const skillRef = path.resolve(file);
      return [
        id,
        { id, skill_ref: skillRef, skill_digest: skillDigest(skillRef) },
      ];
    }),
  );
  const plan = {
    schema_version: 2,
    dataset_file: path.resolve(datasetFile),
    dataset_digest: loaded.digest,
    skills,
    model,
    effort,
    billing_mode: "subscription",
    cli_version: providerVersion(),
    source: "direct-review",
    concurrency: 1,
    draws: 1,
    output_contract: "final-consolidated-v1",
    provenance: {
      label_authority: "agent-audited",
      expert_calibrated: false,
      dataset_exposure:
        "Previously inspected development data; no unseen-performance claim.",
      tools: ["Read", "Grep", "Glob"],
      executed_tests_by_reviewer: false,
    },
    execution_digest: digestFiles(EXECUTION_FILES),
    prompt_sha256: sha256Bytes(readFileSync(path.join(REPO_ROOT, PROMPT))),
    case_ids: loaded.dataset.cases.map((fixture) => fixture.id),
    cells: loaded.dataset.cases.flatMap((fixture, index) =>
      (index % 2 === 0
        ? ["incumbent", "candidate"]
        : ["candidate", "incumbent"]
      ).map((treatment) => ({ case_id: fixture.id, treatment })),
    ),
    created_at: new Date().toISOString(),
  };
  const planFile = path.join(root, "plan.json");
  if (existsSync(planFile))
    throw new Error(
      "plan already exists; resume it or choose another artifact directory",
    );
  mkdirSync(root, { recursive: true });
  writeJson(planFile, { ...plan, plan_digest: digestObject(plan) });
  return plan;
}

function readPlan(out, { scoreOnly = false } = {}) {
  const stored = JSON.parse(readFileSync(path.join(out, "plan.json"), "utf8"));
  const { plan_digest: digest, ...body } = stored;
  if (digestObject(body) !== digest) throw new Error("plan digest mismatch");
  if (body.billing_mode !== "subscription" || Object.hasOwn(body, "budget_usd"))
    throw new Error(
      "legacy dollar-budget plan; create a new subscription plan and preserve existing evidence",
    );
  if (body.execution_digest !== digestFiles(EXECUTION_FILES))
    throw new Error("execution source changed since plan; create a new plan");
  if (
    body.prompt_sha256 !==
    sha256Bytes(readFileSync(path.join(REPO_ROOT, PROMPT)))
  )
    throw new Error("review prompt changed since plan");
  for (const skill of scoreOnly ? [] : Object.values(body.skills)) {
    if (skillDigest(skill.skill_ref) !== skill.skill_digest)
      throw new Error("skill snapshot changed since plan");
  }
  return stored;
}

export function reviewerPrompt(
  plan,
  diff,
  file = path.join(REPO_ROOT, PROMPT),
) {
  const bytes = readFileSync(file);
  if (sha256Bytes(bytes) !== plan.prompt_sha256)
    throw new Error("review prompt changed since plan");
  return `${bytes.toString("utf8")}\n<diff>\n${diff}\n</diff>\n`;
}

function prepareCase({ fixture, dataset, datasetFile, out }) {
  const isolated = materializeFixture({
    contract: { repo: dataset.repo, fixtures: [fixture] },
    pr: fixture.pr,
    cacheDir: path.join(out, "fixtures"),
    srcRepo: REPO_ROOT,
    repoRoot: REPO_ROOT,
    forbidden: fixture.forbidden_shas,
  });
  if (
    !resetFixture({
      fixturePath: isolated.path,
      head: fixture.first_head,
      cellId: fixture.id,
    })
  )
    throw new Error("fixture reset failed");
  if (fixture.repair) {
    const patch = path.resolve(path.dirname(datasetFile), fixture.repair.file);
    if (sha256Bytes(readFileSync(patch)) !== fixture.repair.sha256)
      throw new Error("repair digest mismatch");
    execFileSync("git", ["apply", "--check", patch], { cwd: isolated.path });
    execFileSync("git", ["apply", patch], { cwd: isolated.path });
  }
  return isolated;
}

export async function runCampaign({
  out,
  scoreOnly = false,
  datasetFile = null,
}) {
  out = path.resolve(out);
  const plan = readPlan(out, { scoreOnly });
  const sourceFile = datasetFile
    ? path.resolve(datasetFile)
    : plan.dataset_file;
  const loaded = loadDataset({ file: sourceFile });
  const caseIds = loaded.dataset.cases.map((item) => item.id).sort();
  if (JSON.stringify(caseIds) !== JSON.stringify([...plan.case_ids].sort())) {
    throw new Error(
      "dataset case set differs from plan; create a new plan for a changed panel",
    );
  }
  if (!scoreOnly && loaded.digest !== plan.dataset_digest)
    throw new Error("dataset changed since planning");
  const version = providerVersion();
  if (!scoreOnly && version !== plan.cli_version)
    throw new Error("provider version changed since planning");
  const lock = path.join(out, "active.lock");
  mkdirSync(lock); // An abandoned lock requires operator inspection, never an automatic takeover.
  const rows = [];
  const started = Date.now();
  let failure = null;
  let provider;
  try {
    provider = createProvider({
      out,
      repoRoot: REPO_ROOT,
      version,
    });
    for (const cell of plan.cells) {
      if (digestFiles(EXECUTION_FILES) !== plan.execution_digest)
        throw new Error("execution source changed during campaign");
      if (providerVersion() !== version)
        throw new Error("provider version changed during campaign");
      const fixture = loaded.dataset.cases.find(
        (item) => item.id === cell.case_id,
      );
      if (!fixture) throw new Error(`missing case ${cell.case_id}`);
      const identity = executionIdentity({
        plan,
        fixture,
        treatment: cell.treatment,
      });
      let raw = readExperimentCache({
        artifactRoot: out,
        kind: "raw",
        identity,
      });
      const reused = Boolean(raw);
      let isolated = null;
      const prepare = () => {
        isolated = prepareCase({
          fixture,
          dataset: loaded.dataset,
          datasetFile: sourceFile,
          out,
        });
        verifyCaseProbes({
          fixturePath: isolated.path,
          caseId: fixture.id,
          dataset: loaded.dataset,
        });
        return isolated;
      };
      if (!raw) {
        if (scoreOnly)
          throw new Error(
            `no compatible raw result for ${fixture.id}/${cell.treatment}`,
          );
        prepare();
        const systemPrompt = stageExperimentSkill({
          fixturePath: isolated.path,
          skill: plan.skills[cell.treatment],
        });
        let result;
        try {
          process.stderr.write(`review ${fixture.id}/${cell.treatment}\n`);
          const before = sourceState(isolated.path);
          const diff = sourceDiff(isolated.path);
          const prompt = reviewerPrompt(plan, diff);
          result = await provider.invoke({
            label: `${fixture.id}/${cell.treatment}/review`,
            prompt,
            systemPrompt,
            model: plan.model,
            effort: plan.effort,
            cwd: isolated.path,
            reviewer: true,
            allowedTools: ["Read", "Grep", "Glob"],
            maxTurns: 60,
          });
          if (sourceState(isolated.path) !== before)
            throw new Error("reviewer mutated source fixture");
          result.source_state = before;
        } finally {
          purgeExperimentSkill(isolated.path);
        }
        raw = writeExperimentCache({
          artifactRoot: out,
          kind: "raw",
          identity,
          payload: {
            final_text: result.envelope.result,
            stream: result.stream,
            envelope: result.envelope,
            completed: true,
            output_contract: plan.output_contract,
            call_id: result.call_id,
            source_state: result.source_state,
          },
        });
      }
      if (
        raw.payload.completed !== true ||
        raw.payload.output_contract !== plan.output_contract ||
        raw.payload.envelope?.is_error !== false ||
        typeof raw.payload.final_text !== "string" ||
        !raw.payload.final_text.trim()
      ) {
        throw new Error("raw artifact lacks a completed final-review contract");
      }
      const leak = leakSignals({
        transcript: parseClaudeStream(raw.payload.stream).messages.join("\n"),
        truth: { findings: loaded.dataset.roots },
        pr: fixture.pr,
        forbiddenShas: fixture.forbidden_shas,
      });
      if (leak.suspected)
        throw new Error(`possible answer-key leak: ${leak.hard.join("; ")}`);
      const scoreId = scoringIdentity({
        rawDigest: raw.artifact.content_digest,
        datasetDigest: loaded.digest,
        scorerDigest: scorerDigestV2(),
        model: plan.model,
        effort: plan.effort,
        version,
      });
      let scored = readExperimentCache({
        artifactRoot: out,
        kind: "score",
        identity: scoreId,
      });
      const scoreReused = Boolean(scored);
      if (!scored) {
        prepare();
        if (sourceState(isolated.path) !== raw.payload.source_state)
          throw new Error("source fixture differs from raw execution");
        let judgeIndex = 0;
        const exec = async (request) => {
          if (scorerDigestV2() !== scoreId.scorer_digest)
            throw new Error("scorer changed during grading");
          const before = sourceState(isolated.path);
          const result = await provider.invoke({
            ...request,
            label: `${fixture.id}/${cell.treatment}/judge-${judgeIndex++}`,
          });
          if (sourceState(isolated.path) !== before)
            throw new Error("grader mutated source fixture");
          return JSON.stringify(result.envelope);
        };
        process.stderr.write(`score ${fixture.id}/${cell.treatment}\n`);
        const result = await scoreReview({
          review: {
            finalText: raw.payload.final_text,
            completed: raw.payload.completed,
            outputContract: raw.payload.output_contract,
          },
          defects: rootsForCase(loaded.dataset, fixture.id),
          sourceDiff: sourceDiff(isolated.path),
          fixturePath: isolated.path,
          judge: { exec, model: plan.model, effort: plan.effort },
        });
        if (result.errors?.length) {
          writeJson(path.join(out, "last-grading-error.json"), {
            ...cell,
            result,
          });
          throw new Error(
            `grading failed for ${fixture.id}/${cell.treatment}: ${result.errors.map((error) => error.message).join("; ")}`,
          );
        }
        scored = writeExperimentCache({
          artifactRoot: out,
          kind: "score",
          identity: scoreId,
          payload: result,
        });
      }
      rows.push({
        ...cell,
        raw_digest: raw.artifact.content_digest,
        score_digest: scored.artifact.content_digest,
        raw_reused: reused,
        score_reused: scoreReused,
        score: scored.payload,
        expected_root_ids: fixture.expected_root_ids,
        negative_control_root_ids: fixture.negative_control_root_ids,
        roots: rootsForCase(loaded.dataset, fixture.id).map(
          ({ id, severity }) => ({ id, severity }),
        ),
        raw_file: raw.file,
        score_file: scored.file,
        family_id: fixture.family_id,
        variant: fixture.variant,
        reviewer_duration_ms: raw.payload.envelope.duration_ms,
        reviewer_cost_usd: raw.payload.envelope.total_cost_usd,
        leak,
      });
      if (scored.payload.errors?.length)
        throw new Error(`grading failed for ${fixture.id}/${cell.treatment}`);
    }
  } catch (error) {
    failure = error.message;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  const report = campaignReport({
    plan,
    rows,
    failure,
    spend: provider?.ledger ?? null,
    datasetDigest: loaded.digest,
  });
  report.elapsed_ms = Date.now() - started;
  writeJson(path.join(out, "report.json"), report);
  return report;
}

export function campaignReport({
  plan,
  rows,
  failure = null,
  spend,
  datasetDigest,
}) {
  const complete =
    !failure &&
    rows.length === plan.cells.length &&
    rows.every((row) => !row.score.errors?.length);
  const sameSkill =
    plan.skills.incumbent.skill_digest === plan.skills.candidate.skill_digest;
  return {
    schema_version: 2,
    status: complete ? "completed" : "incomplete",
    failure,
    source: "direct-review",
    qualification: sameSkill
      ? "A/A harness qualification"
      : "paired diagnostic comparison",
    inference:
      "No promotion decision; labels and grader have no independent expert calibration.",
    plan_digest: plan.plan_digest,
    dataset_digest: datasetDigest,
    provenance: plan.provenance,
    planned_cells: plan.cells.length,
    completed_cells: rows.length,
    grading_uncertainty: rows.some((row) => row.score.status !== "complete"),
    metrics: metricSummary(rows),
    cost: spend
      ? {
          actual_known_usd: spend.calls.reduce(
            (sum, call) => sum + (call.actual_usd ?? 0),
            0,
          ),
          reserved_or_spent_usd: spend.calls.reduce(
            (sum, call) => sum + call.charged_usd,
            0,
          ),
          unknown_cost_calls: spend.calls.filter(
            (call) => call.actual_usd === null,
          ).length,
          limit_usd: spend.limit_usd,
          note: "API-equivalent usage estimates, not account charges. Subscription runs have no dollar stop; missing usage remains unknown.",
        }
      : null,
    rows,
  };
}
