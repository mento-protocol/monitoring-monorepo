#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_SERVER_URL = "https://github.com";
const DEFAULT_SLACK_CHANNEL = "#deploys";
const DEFAULT_STALE_MINUTES = 60;
const USER_AGENT = "mento-monitoring-terraform-deploy-queue-watch";
const MAX_SLACK_RUNS = 8;

const DEPLOY_WORKFLOWS = [
  {
    name: "Governance Watchdog Infra",
    workflowFile: "governance-watchdog.yml",
  },
  {
    name: "Alerts Infra",
    workflowFile: "alerts-infra.yml",
  },
  {
    name: "Alerts Rules",
    workflowFile: "alerts-rules.yml",
  },
  {
    name: "Aegis Terraform",
    workflowFile: "aegis-terraform.yml",
  },
];

const QUEUE_STATUSES = new Set(["queued", "pending", "requested", "waiting"]);
const DEPLOY_EVENTS = new Set(["push", "workflow_dispatch"]);

function slackEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isDeployQueueCandidate(run) {
  if (!QUEUE_STATUSES.has(run.status)) {
    return false;
  }

  if (!DEPLOY_EVENTS.has(run.event)) {
    return false;
  }

  return run.head_branch === "main";
}

function summarizeJobs(jobs) {
  return {
    total: jobs.length,
    started: jobs.filter((job) => Boolean(job.started_at)).length,
  };
}

function classifyStalledRuns({
  workflows,
  runsByWorkflow,
  jobsByRun,
  now,
  staleMinutes,
}) {
  const staleMs = staleMinutes * 60 * 1000;
  const stalledRuns = [];

  for (const workflow of workflows) {
    const runs = runsByWorkflow.get(workflow.workflowFile) ?? [];
    for (const run of runs) {
      if (!isDeployQueueCandidate(run)) {
        continue;
      }

      const createdAt = new Date(run.created_at);
      if (Number.isNaN(createdAt.getTime())) {
        continue;
      }

      const ageMs = now.getTime() - createdAt.getTime();
      if (ageMs < staleMs) {
        continue;
      }

      const jobs = jobsByRun.get(run.id) ?? [];
      const jobSummary = summarizeJobs(jobs);
      if (jobSummary.started > 0) {
        continue;
      }

      stalledRuns.push({
        workflowName: workflow.name,
        workflowFile: workflow.workflowFile,
        id: run.id,
        runNumber: run.run_number,
        status: run.status,
        event: run.event,
        actor: run.triggering_actor?.login ?? run.actor?.login ?? "unknown",
        branch: run.head_branch ?? "unknown",
        sha: run.head_sha ?? "",
        createdAt: run.created_at,
        ageMs,
        jobs: jobSummary,
        url: run.html_url,
      });
    }
  }

  return stalledRuns.sort((a, b) => b.ageMs - a.ageMs);
}

async function githubJson({
  fetchImpl,
  apiUrl,
  githubToken,
  path,
  searchParams,
}) {
  const url = new URL(path, `${apiUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${url.pathname} failed: ${response.status} ${body}`,
    );
  }

  return response.json();
}

async function fetchWorkflowRuns({
  fetchImpl,
  apiUrl,
  githubToken,
  repo,
  workflowFile,
}) {
  const payload = await githubJson({
    fetchImpl,
    apiUrl,
    githubToken,
    path: `repos/${repo}/actions/workflows/${workflowFile}/runs`,
    searchParams: { per_page: 100 },
  });

  return payload.workflow_runs ?? [];
}

async function fetchRunJobs({ fetchImpl, apiUrl, githubToken, repo, runId }) {
  const payload = await githubJson({
    fetchImpl,
    apiUrl,
    githubToken,
    path: `repos/${repo}/actions/runs/${runId}/jobs`,
    searchParams: { per_page: 100 },
  });

  return payload.jobs ?? [];
}

async function findStalledDeployRuns({
  fetchImpl,
  apiUrl,
  githubToken,
  repo,
  workflows = DEPLOY_WORKFLOWS,
  now = new Date(),
  staleMinutes = DEFAULT_STALE_MINUTES,
}) {
  const runsByWorkflow = new Map();
  const jobsByRun = new Map();

  for (const workflow of workflows) {
    const runs = await fetchWorkflowRuns({
      fetchImpl,
      apiUrl,
      githubToken,
      repo,
      workflowFile: workflow.workflowFile,
    });
    const candidates = runs.filter(isDeployQueueCandidate);
    runsByWorkflow.set(workflow.workflowFile, runs);

    for (const run of candidates) {
      const jobs = await fetchRunJobs({
        fetchImpl,
        apiUrl,
        githubToken,
        repo,
        runId: run.id,
      });
      jobsByRun.set(run.id, jobs);
    }
  }

  return classifyStalledRuns({
    workflows,
    runsByWorkflow,
    jobsByRun,
    now,
    staleMinutes,
  });
}

function buildSlackPayload({
  channel,
  repo,
  serverUrl,
  watcherRunUrl,
  staleMinutes,
  stalledRuns,
}) {
  const visibleRuns = stalledRuns.slice(0, MAX_SLACK_RUNS);
  const moreCount = stalledRuns.length - visibleRuns.length;
  const runLines = visibleRuns
    .map((run) => {
      const url = run.url || `${serverUrl}/${repo}/actions/runs/${run.id}`;
      const sha = run.sha ? run.sha.slice(0, 7) : "unknown";
      return [
        `*<${url}|${slackEscape(run.workflowName)} #${slackEscape(run.runNumber)}>*`,
        `status \`${slackEscape(run.status)}\``,
        `event \`${slackEscape(run.event)}\``,
        `branch \`${slackEscape(run.branch)}\``,
        `sha \`${slackEscape(sha)}\``,
        `actor \`${slackEscape(run.actor)}\``,
        `age ${slackEscape(formatDuration(run.ageMs))}`,
        `started jobs ${run.jobs.started}/${run.jobs.total}`,
      ].join(" · ");
    })
    .join("\n");
  const suffix =
    moreCount > 0 ? `\n...and ${moreCount} more stale deploy run(s).` : "";

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *Terraform deploy queue may be wedged*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `One or more production Terraform deploy workflows have been queued/pending for at least ${staleMinutes}m with zero started jobs. ` +
          "Because their deploy concurrency groups use `cancel-in-progress: false`, an older stalled run can block later applies.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${runLines}${suffix}`,
      },
    },
  ];

  if (watcherRunUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open watcher run" },
          url: watcherRunUrl,
        },
      ],
    });
  }

  return {
    channel,
    text: `Terraform deploy queue may be wedged: ${stalledRuns.length} stale run(s)`,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}

async function postToSlack({ fetchImpl, slackToken, payload }) {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  if (!response.ok || body?.ok !== true) {
    throw new Error(
      `Slack chat.postMessage failed: ${body?.error ?? response.status}`,
    );
  }
}

async function main(
  env = process.env,
  argv = process.argv.slice(2),
  fetchImpl = globalThis.fetch,
) {
  if (!fetchImpl) {
    throw new Error("global fetch is required");
  }

  const repo = env.GITHUB_REPOSITORY;
  const githubToken = env.GITHUB_TOKEN;
  const apiUrl = env.GITHUB_API_URL || DEFAULT_API_URL;
  const serverUrl = env.GITHUB_SERVER_URL || DEFAULT_SERVER_URL;
  const staleMinutes = parsePositiveInteger(
    env.TERRAFORM_DEPLOY_STALE_MINUTES ?? env.STALE_MINUTES,
    DEFAULT_STALE_MINUTES,
  );
  const dryRun = argv.includes("--dry-run") || env.DRY_RUN === "true";

  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required");
  }
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const stalledRuns = await findStalledDeployRuns({
    fetchImpl,
    apiUrl,
    githubToken,
    repo,
    staleMinutes,
  });

  if (stalledRuns.length === 0) {
    console.log(
      `No Terraform deploy workflow runs older than ${staleMinutes}m are queued/pending/requested/waiting with zero started jobs.`,
    );
    return { stalledRuns };
  }

  const watcherRunUrl =
    env.GITHUB_RUN_ID && repo
      ? `${serverUrl}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : "";
  const channel = env.SLACK_CHANNEL || DEFAULT_SLACK_CHANNEL;
  const payload = buildSlackPayload({
    channel,
    repo,
    serverUrl,
    watcherRunUrl,
    staleMinutes,
    stalledRuns,
  });

  console.error(
    `Detected ${stalledRuns.length} Terraform deploy run(s) queued/pending/requested/waiting for at least ${staleMinutes}m with zero started jobs.`,
  );
  for (const run of stalledRuns) {
    console.error(
      `- ${run.workflowName} #${run.runNumber}: ${run.status}, ${formatDuration(run.ageMs)}, ${run.url}`,
    );
  }

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    if (!env.SLACK_BOT_TOKEN) {
      throw new Error(
        "SLACK_BOT_TOKEN is required when stalled deploy runs are detected",
      );
    }
    await postToSlack({ fetchImpl, slackToken: env.SLACK_BOT_TOKEN, payload });
    console.log(`Posted Terraform deploy queue warning to ${channel}.`);
  }

  process.exitCode = 1;
  return { stalledRuns, payload };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_SLACK_CHANNEL,
  DEPLOY_WORKFLOWS,
  buildSlackPayload,
  classifyStalledRuns,
  findStalledDeployRuns,
  formatDuration,
  isDeployQueueCandidate,
  main,
  summarizeJobs,
};
