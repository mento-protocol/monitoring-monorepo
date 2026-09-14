import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const REPOSITORY = "mento-protocol/monitoring-monorepo";
export const BASE = "c186a7e5ca0433c80d7588acb4ab38f24988ccc7";
export const ANCHOR = 34836768852;
export const BASELINE_SECONDS = 27587;
export const WORKFLOW = "m6-audit-recovery.yml";
export const REVIEWED_FAILURE = 34872200578;
export function failureReceiptDigest(run, jobs) {
  const runKeys = [
    "id",
    "event",
    "head_branch",
    "head_sha",
    "path",
    "workflow_id",
    "display_title",
    "status",
    "conclusion",
    "run_attempt",
    "created_at",
    "updated_at",
    "run_started_at",
  ];
  const jobKeys = [
    "id",
    "run_id",
    "run_attempt",
    "head_sha",
    "name",
    "status",
    "conclusion",
    "started_at",
    "completed_at",
    "runner_id",
  ];
  return createHash("sha256")
    .update(
      JSON.stringify({
        run: runKeys.map((key) => run[key]),
        references: run.referenced_workflows
          .map(({ path, sha, ref }) => [path, sha, ref])
          .sort(),
        jobs: [...jobs]
          .sort((a, b) => a.id - b.id)
          .map((job) => jobKeys.map((key) => job[key])),
      }),
    )
    .digest("hex");
}
export const TUPLES = Object.freeze({
  2399: Object.freeze({
    source: "e771a3a4be4c32c98322e494412ae064f2a328a2",
    merge: "275207b77c85942837e26e158ba9fe78affff57a",
  }),
  2408: Object.freeze({
    source: "645b8197ce5a0a96301f6425889592b5782bfb6e",
    merge: "199df9dcace086097540a2a8a4edacb9c0ea703d",
  }),
});
const DISPATCH = ".github/workflows/no-skip-audit.yml";
const REVIEWED_ADMISSION_FILES = new Set([
  "scripts/workflows/check-no-skip-audit.mjs",
  "scripts/workflows/check-no-skip-audit.test.mjs",
  "scripts/workflows/check-ci-contract.test.mjs",
]);
const requireFact = (condition, message) => {
  if (!condition) throw new Error(message);
};
export function validateIdentity(context, pull, main) {
  const tuple = TUPLES[String(context.payload.inputs?.pr_number)];
  requireFact(tuple, "Unapproved PR number");
  requireFact(
    context.eventName === "workflow_dispatch" &&
      context.ref === "refs/heads/main",
    "Protected-main manual dispatch required",
  );
  requireFact(
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY,
    "Unexpected repository",
  );
  requireFact(
    context.sha === main && /^[a-f0-9]{40}$/u.test(main),
    "Workflow revision is not current main",
  );
  requireFact(
    Number(context.runAttempt) === 1,
    "Recovery reruns require a new approval",
  );
  requireFact(
    pull.state === "closed" && pull.merged === true && pull.base.ref === "main",
    "Expected merged main PR",
  );
  requireFact(
    pull.head.repo?.full_name === REPOSITORY &&
      pull.base.repo?.full_name === REPOSITORY,
    "Cross-repository PR refused",
  );
  requireFact(
    pull.head.sha === tuple.source && pull.merge_commit_sha === tuple.merge,
    "Recorded head or merge changed",
  );
  requireFact(
    String(pull.number) === String(context.payload.inputs.pr_number),
    "PR identity mismatch",
  );
  return tuple;
}
export function verifyGit(
  tuple,
  revision,
  git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim(),
) {
  requireFact(
    git("rev-parse", "HEAD") === revision,
    "Checkout is not the workflow revision",
  );
  for (const sha of [BASE, tuple.source, tuple.merge, revision])
    requireFact(
      git("rev-parse", `${sha}^{commit}`) === sha,
      "Missing exact commit",
    );
  git("merge-base", "--is-ancestor", tuple.merge, revision);
  const parent = git("rev-parse", `${tuple.merge}^1`);
  requireFact(
    git("merge-base", parent, tuple.source) === BASE,
    "Historical base mismatch",
  );
  const cleanTree = git("merge-tree", "--write-tree", parent, tuple.source);
  requireFact(
    cleanTree === git("rev-parse", `${tuple.merge}^{tree}`),
    "Merge is not the clean integration of the source",
  );
  const dispatcher = git("show", `${BASE}:${DISPATCH}`);
  const block = dispatcher
    .split("          protected_paths=(\n")[1]
    ?.split("\n          )")[0];
  requireFact(block, "Historical protected paths unavailable");
  const paths = block
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/gu, ""));
  git("diff", "--exit-code", BASE, tuple.source, "--", ...paths);
  // Only the separately reviewed admission contracts may differ. The retained
  // workflow, actions, dependency inputs and original dispatcher stay exact.
  git(
    "diff",
    "--exit-code",
    BASE,
    revision,
    "--",
    ...paths.filter((path) => !REVIEWED_ADMISSION_FILES.has(path)),
  );
  return {
    base: BASE,
    source: tuple.source,
    merge: tuple.merge,
    tree: cleanTree,
    revision,
  };
}
export function jobSeconds(attempts) {
  const seen = new Set();
  let seconds = 0;
  for (const jobs of attempts)
    for (const job of jobs) {
      if (job.conclusion === "skipped") continue;
      const start = Date.parse(job.started_at),
        end = Date.parse(job.completed_at);
      requireFact(
        Number.isFinite(start) && Number.isFinite(end) && end >= start,
        "Incomplete job timing",
      );
      const identity = JSON.stringify([
        job.name,
        job.started_at,
        job.completed_at,
        job.runner_id,
        job.steps,
      ]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      seconds += (end - start) / 1000;
    }
  return seconds;
}
export async function admitRecovery({ github, context, git }) {
  const repo = context.repo,
    actions = github.rest.actions;
  const pr = context.payload.inputs?.pr_number;
  const { data: main } = await github.rest.git.getRef({
    ...repo,
    ref: "heads/main",
  });
  const { data: pull } = await github.rest.pulls.get({
    ...repo,
    pull_number: Number(pr),
  });
  const tuple = validateIdentity(context, pull, main.object.sha);
  // Squash-merged source heads may only remain reachable through hidden PR refs.
  // Fetch the approved immutable object without persisting any credentials.
  const runGit =
    git ??
    ((...args) => execFileSync("git", args, { encoding: "utf8" }).trim());
  runGit(
    "fetch",
    "--no-tags",
    `https://github.com/${REPOSITORY}.git`,
    tuple.source,
  );
  const proof = verifyGit(tuple, context.sha, runGit);
  const { data: collector } = await actions.getWorkflow({
    ...repo,
    workflow_id: "m6-canary.yml",
  });
  requireFact(
    collector.state === "disabled_manually",
    "Disable automatic collection before recovery",
  );
  const list = (workflow_id) =>
    github.paginate(actions.listWorkflowRuns, {
      ...repo,
      workflow_id,
      per_page: 100,
    });
  const ordinary = await list("no-skip-audit.yml");
  requireFact(
    ordinary.some(
      (run) =>
        run.id === ANCHOR &&
        run.run_attempt === 1 &&
        run.status === "completed",
    ),
    "Budget anchor unavailable or rerun",
  );
  requireFact(
    ordinary.every((run) => run.status === "completed"),
    "Drain ordinary audits first",
  );
  requireFact(
    ordinary.every(
      (run) =>
        run.id > ANCHOR ||
        Date.parse(run.updated_at) <= Date.parse("2026-09-14T11:14:19Z"),
    ),
    "Historical audit changed after budget reconciliation",
  );
  requireFact(
    ordinary.every((run) => run.id <= ANCHOR),
    "New ordinary audit requires separate review",
  );
  const collectors = await list("m6-canary.yml");
  requireFact(
    collectors.every((run) => run.status === "completed"),
    "Drain collection first",
  );
  const recovery = await list(WORKFLOW);
  requireFact(
    recovery.some((run) => run.id === REVIEWED_FAILURE),
    "Reviewed failed run missing",
  );
  requireFact(recovery.length <= 3, "Finite recovery amendment exhausted");
  const current = recovery.find((run) => run.id === Number(context.runId));
  const title = `M6 recovery PR #${pr}`;
  requireFact(
    current?.display_title === title &&
      current.run_attempt === 1 &&
      current.head_sha === context.sha,
    "Current run binding mismatch",
  );
  requireFact(
    !recovery.some(
      (run) =>
        run.id !== current.id &&
        run.id !== REVIEWED_FAILURE &&
        run.display_title === title,
    ),
    "Tuple already attempted; no automatic retry",
  );
  let seconds = BASELINE_SECONDS;
  for (const run of [
    ...ordinary.filter((item) => item.id > ANCHOR),
    ...recovery.filter((item) => item.id !== current.id),
  ]) {
    requireFact(run.status === "completed", "Drain other recovery runs first");
    requireFact(
      Number.isInteger(run.run_attempt) && run.run_attempt > 0,
      "Invalid attempt count",
    );
    const attempts = [];
    for (
      let attempt_number = 1;
      attempt_number <= run.run_attempt;
      attempt_number++
    )
      attempts.push(
        await github.paginate(actions.listJobsForWorkflowRunAttempt, {
          ...repo,
          run_id: run.id,
          attempt_number,
          per_page: 100,
        }),
      );
    const used = jobSeconds(attempts);
    requireFact(used <= 45 * 60, "Previous audit exceeded per-run stop");
    seconds += used;
    requireFact(
      !recovery.some((item) => item.id === run.id) || run.run_attempt === 1,
      "Prior recovery rerun requires separate review",
    );
    if (run.id === REVIEWED_FAILURE) {
      const { data: recorded } = await actions.getWorkflowRun({
        ...repo,
        run_id: REVIEWED_FAILURE,
      });
      requireFact(
        run.run_attempt === recorded.run_attempt &&
          run.updated_at === recorded.updated_at &&
          used === 1396 &&
          failureReceiptDigest(recorded, attempts[0]) ===
            "679616ffaf626f6f6304e4227bfa0692cf08cee37b3f434f7bcc93f0919b1b2e",
        "Reviewed failed run evidence changed",
      );
      continue;
    }
    requireFact(
      run.display_title ===
        `M6 recovery PR #${pr === "2399" ? "2408" : "2399"}` &&
        run.event === "workflow_dispatch" &&
        run.head_branch === "main" &&
        run.path === `.github/workflows/${WORKFLOW}` &&
        run.head_sha === context.sha,
      "Unapproved prior recovery run",
    );
    requireFact(
      run.conclusion === "success",
      "Prior audit failure requires classification and separate recovery review",
    );
  }
  requireFact(
    ordinary.filter((run) => run.id > ANCHOR).length + recovery.length <= 6,
    "Additional audit selection limit reached",
  );
  requireFact(
    seconds + 45 * 60 <= 800 * 60,
    "Insufficient cumulative budget for reservation",
  );
  // Re-read after all API/Git work. Operator must not dispatch other lanes in
  // parallel; the recovery workflow serializes its own runs without cancellation.
  const { data: fresh } = await github.rest.git.getRef({
    ...repo,
    ref: "heads/main",
  });
  requireFact(
    fresh.object.sha === context.sha,
    "Main advanced during admission",
  );
  return {
    ...proof,
    secondsBeforeRun: seconds,
    reservedSeconds: 2700,
    reviewedFailure: REVIEWED_FAILURE,
    pr: Number(pr),
  };
}
