const ISSUE = 2128;
const MARKER = "<!-- m6-canary-reservation-v1 -->";
const STOP = "<!-- m6-canary-stop-v1 -->";
const CUTOFF = Date.parse("2026-09-04T19:13:41Z");
const HISTORICAL_MINUTES = 8785 / 60;
const SHA = /^[a-f0-9]{40}$/u;
const executionPath = (path) =>
  /(^|\/)(?:package\.(?:json5?|yaml)|pnpm-(?:workspace|lock)\.yaml|\.npmrc|\.?pnpmfile\.cjs|patches|node_modules)(?:\/|$)/u.test(
    path,
  ) || path === ".node-version";
const instrumentPath = (path) =>
  /^(?:\.github\/(?:workflows\/(?:ci|no-skip-audit|m6-canary)\.yml$|actions\/(?:pnpm-install|resolve-eslint-baseline)(?:\/|$))|scripts\/(?:workflows\/(?:check-ci-contract|check-no-skip-audit|collect-m6-canary)(?:\.test)?\.mjs$|bootstrap\/agent-setup-contract\.test\.sh$|indexer-handler-invariant-contract\.test\.mjs$|repo-health\/dependency-cruiser-root-contract\.test\.mjs$|lib\/workflow-yaml\.mjs$))/u.test(
    path,
  );

export function readReservation(comment) {
  if (
    comment.user?.login !== "github-actions[bot]" ||
    !comment.body.startsWith(MARKER)
  )
    return null;
  const record = JSON.parse(comment.body.split("\n")[1]);
  if (
    !Number.isSafeInteger(record.pr) ||
    record.pr < 1 ||
    !SHA.test(record.head) ||
    !SHA.test(record.base) ||
    !Number.isSafeInteger(record.ordinaryRun)
  )
    throw new Error(`Malformed reservation ${comment.id}`);
  return { ...record, commentId: comment.id };
}

function body(record) {
  const { commentId: _commentId, ...stored } = record;
  return `${MARKER}\n${JSON.stringify(stored)}\n\nM6 provisional evidence for #${record.pr}. Source: ${record.head}; base: ${record.base}; ordinary CI: ${record.ordinaryRun}; audit: ${record.auditRun ?? (record.form === "ordinary-pending" ? "not dispatched" : "dispatch unresolved")}.\n\n${record.status ?? (record.form === "ordinary-pending" ? "Ordinary force-all proof pending. No audit dispatched." : "Reserved before dispatch. Do not retry an ambiguous dispatch.")}\n\nHuman acceptance still requires author-check results and durations, risk and package coverage, deployment evidence where applicable, and safeguard-omission classification. This receipt does not accept a sample or authorize retirement.`;
}

export async function collectM6Canary({ github, context, core }) {
  const repo = context.repo;
  const { actions, issues, pulls, git, repos } = github.rest;
  const fullName = `${repo.owner}/${repo.repo}`;
  const ownsRun = (run, workflow, event) =>
    run.path === `.github/workflows/${workflow}.yml` &&
    run.event === event &&
    run.repository?.full_name === fullName &&
    run.head_repository?.full_name === fullName;
  if (
    context.ref !== "refs/heads/main" ||
    `${repo.owner}/${repo.repo}` !== "mento-protocol/monitoring-monorepo"
  )
    throw new Error("Use protected main in the owning repository");
  const list = (method, args) =>
    github.paginate(method, { ...repo, per_page: 100, ...args });
  const get = async (method, args) => (await method({ ...repo, ...args })).data;
  const runList = (workflow_id, event, head_sha) =>
    list(actions.listWorkflowRuns, { workflow_id, event, head_sha });
  const post = (body) =>
    issues.createComment({ ...repo, issue_number: ISSUE, body });
  const main = await get(git.getRef, { ref: "heads/main" });
  if (context.sha !== main.object.sha)
    return { stopped: "Collector revision is no longer main" };
  const update = (record) =>
    issues.updateComment({
      ...repo,
      comment_id: record.commentId,
      body: body(record),
    });
  const stop = async (reason) => {
    core.setFailed(reason);
    const message = `${STOP}\nM6 collection stopped: ${reason}. No new audit dispatched. Review before resuming.`;
    await post(message);
    return { stopped: reason };
  };
  const comments = await list(issues.listComments, { issue_number: ISSUE });
  if ((await get(issues.get, { issue_number: ISSUE })).state !== "open")
    return { stopped: "M6 issue is closed" };
  if (
    comments.some(
      (c) => c.user?.login === "github-actions[bot]" && c.body.startsWith(STOP),
    )
  )
    return { stopped: "M6 stop marker requires reviewed disposition" };
  const records = comments.map(readReservation).filter(Boolean);
  if (new Set(records.map((r) => r.pr)).size !== records.length)
    return stop("Duplicate PR reservations");
  const runs = await runList("no-skip-audit.yml");
  let minutes = HISTORICAL_MINUTES;
  const jobsSeen = new Set();
  const charged = new Map();
  for (const run of runs) {
    if (run.status === "completed" && Date.parse(run.updated_at) <= CUTOFF)
      continue;
    if (run.status !== "completed") return { waiting: run.id };
    if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)
      return stop(`Unknown attempt count for audit ${run.id}`);
    let runMinutes = 0;
    let entireRunMinutes = 0;
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      const jobs = await list(actions.listJobsForWorkflowRunAttempt, {
        run_id: run.id,
        attempt_number: attempt,
      });
      if (!jobs.length) return stop(`Missing jobs: ${run.id}/${attempt}`);
      for (const job of jobs) {
        if (job.status !== "completed") return stop(`Incomplete job ${job.id}`);
        if (job.conclusion === "skipped")
          return stop(`Skipped audit job ${job.id}`);
        const started = Date.parse(job.started_at),
          ended = Date.parse(job.completed_at);
        if (!(ended >= started))
          return stop(`Unknown duration for job ${job.id}`);
        if (jobsSeen.has(job.id)) continue;
        jobsSeen.add(job.id);
        entireRunMinutes += (ended - started) / 60000;
        if (ended <= CUTOFF) continue;
        if (started < CUTOFF)
          return stop(`Job ${job.id} crosses the cost baseline`);
        runMinutes += (ended - started) / 60000;
        if (job.conclusion !== "success")
          return stop(`Audit ${run.id} job ${job.id} ended ${job.conclusion}`);
      }
    }
    if (run.conclusion !== "success")
      return stop(`Audit ${run.id} ended ${run.conclusion}`);
    minutes += runMinutes;
    charged.set(run.id, runMinutes);
    if (entireRunMinutes > 45)
      return stop(`Audit ${run.id} exceeded 45 runner-minutes`);
    if (!records.some((record) => record.auditRun === run.id))
      return stop(`Unreserved audit ${run.id}; reconcile spend and selection`);
  }
  for (const record of records) {
    if (!record.auditRun && record.form !== "ordinary-pending")
      return stop(`PR #${record.pr}: unresolved dispatch reservation`);
    const run = runs.find((item) => item.id === record.auditRun);
    if (record.auditRun && !run) {
      await get(actions.getWorkflowRun, { run_id: record.auditRun });
      return { waiting: record.auditRun };
    }
    if (
      record.form !== "ordinary-pending" &&
      (!run ||
        !ownsRun(run, "no-skip-audit", "workflow_dispatch") ||
        run.status !== "completed" ||
        run.conclusion !== "success" ||
        run.head_sha !== record.base ||
        run.display_title !==
          `No-skip audit PR #${record.pr} at ${record.head}`)
    )
      return stop(`Audit identity mismatch for PR #${record.pr}`);
    const pull = await get(pulls.get, { pull_number: record.pr });
    record.auditDate = run?.created_at.slice(0, 10);
    record.runnerMinutes = charged.get(record.auditRun) ?? null;
    record.merged = false;
    if (pull.merged && pull.merge_commit_sha) {
      const mainRuns = await runList("ci.yml", "push", pull.merge_commit_sha);
      record.mergeSha = pull.merge_commit_sha;
      record.mainRun = mainRuns.find(
        (item) =>
          item.head_branch === "main" &&
          ownsRun(item, "ci", "push") &&
          item.status === "completed" &&
          item.head_sha === pull.merge_commit_sha &&
          item.conclusion === "success",
      )?.id;
      record.merged =
        record.form !== "ordinary-pending" &&
        pull.head.sha === record.head &&
        Boolean(record.mainRun);
    }
    record.status =
      record.form === "ordinary-pending"
        ? "Full-graph proof pending; no audit."
        : record.merged
          ? "Merged; main CI passed; tree reconciliation pending."
          : "Merge/main proof pending.";
    if (comments.find((c) => c.id === record.commentId)?.body !== body(record))
      await update(record);
  }
  const dates = [
    "2026-09-04",
    ...records.filter((r) => r.merged).map((r) => r.auditDate),
  ].sort();
  const inclusiveDays =
    (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86400000 + 1;
  if (records.filter((r) => r.merged).length + 1 >= 10 && inclusiveDays >= 7)
    return {
      complete: "Count/date threshold met; human acceptance pending",
      minutes,
    };
  const dateWaiting =
    records.filter((r) => r.auditRun).length >= 8 &&
    Date.now() < Date.parse("2026-09-10T00:00:00Z");
  const candidates = await list(pulls.list, {
    state: "open",
    base: "main",
    sort: "created",
    direction: "asc",
  });
  const excluded = new Set([2291, 2299, ...records.map((r) => r.pr)]);
  for (const candidate of candidates) {
    if (
      excluded.has(candidate.number) ||
      candidate.draft ||
      candidate.head.ref.startsWith("sentry-autofix/")
    )
      continue;
    const pull = await get(pulls.get, { pull_number: candidate.number });
    if (
      pull.state !== "open" ||
      pull.base.ref !== "main" ||
      pull.base.sha !== main.object.sha ||
      pull.head.repo?.full_name !== `${repo.owner}/${repo.repo}` ||
      pull.base.repo?.full_name !== `${repo.owner}/${repo.repo}` ||
      !SHA.test(pull.head.sha)
    )
      continue;
    const files = await list(pulls.listFiles, {
      pull_number: pull.number,
    });
    if (files.length !== pull.changed_files || files.length >= 3000) continue;
    const comparison = await get(repos.compareCommits, {
      base: main.object.sha,
      head: pull.head.sha,
    });
    if (comparison.merge_base_commit?.sha !== main.object.sha) continue;
    const paths = files.flatMap((file) =>
      [file.filename, file.previous_filename].filter(Boolean),
    );
    if (paths.some(instrumentPath)) continue;
    const packageChange = paths.some(executionPath);
    if (!packageChange && dateWaiting) continue;
    const ordinary = await runList("ci.yml", "pull_request", pull.head.sha);
    const latest = ordinary
      .filter(
        (run) =>
          ownsRun(run, "ci", "pull_request") &&
          run.pull_requests?.some(
            (pr) => pr.number === pull.number && pr.base?.sha === pull.base.sha,
          ) &&
          run.head_sha === pull.head.sha &&
          run.head_branch === pull.head.ref,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (latest?.status !== "completed" || latest.conclusion !== "success")
      continue;
    const record = {
      pr: pull.number,
      head: pull.head.sha,
      base: main.object.sha,
      ordinaryRun: latest.id,
      form: packageChange ? "ordinary-pending" : "no-skip",
    };
    const fresh = await get(pulls.get, { pull_number: pull.number });
    const freshMain = await get(git.getRef, { ref: "heads/main" });
    if (
      fresh.state !== "open" ||
      fresh.draft ||
      fresh.head.sha !== record.head ||
      fresh.base.sha !== record.base ||
      freshMain.object.sha !== record.base
    )
      return { waiting: "PR or main changed before reservation" };
    if (!packageChange && minutes + 45 > 450)
      return stop(
        `Remaining budget cannot reserve a 45-minute audit (${minutes.toFixed(2)}/450 used)`,
      );
    const reservation = await post(body(record));
    record.commentId = reservation.data.id;
    if (packageChange) return { ordinaryPending: record.pr, minutes };
    try {
      const response = await github.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        {
          ...repo,
          workflow_id: "no-skip-audit.yml",
          ref: "main",
          inputs: {
            pr_number: String(record.pr),
            source_sha: record.head,
            base_sha: record.base,
          },
          return_run_details: true,
        },
      );
      if (!Number.isSafeInteger(response.data.workflow_run_id))
        throw new Error("Dispatch returned no run ID");
      record.auditRun = response.data.workflow_run_id;
      await update(record);
      return { dispatched: record.auditRun, pr: record.pr, minutes };
    } catch {
      return stop(
        `PR #${record.pr} dispatch is ambiguous; reservation ${record.commentId} must not be retried`,
      );
    }
  }
  return { minutes, dispatched: null, waiting: "No eligible open PR" };
}
