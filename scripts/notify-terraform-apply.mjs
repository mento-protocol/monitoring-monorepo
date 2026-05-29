#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { pathToFileURL } from "node:url";

const DEFAULT_PLAN_FILE = "/tmp/tf-plan.txt";
const DEFAULT_SLACK_CHANNEL = "#ci-failures";
const MAX_RESOURCE_LINES = 10;
const MAX_TYPE_LINES = 8;
const USER_AGENT = "mento-monitoring-terraform-apply-notifier";

const ACTION_ORDER = ["destroy", "replace", "update", "create", "import"];
const ACTION_PHRASES = [
  ["will be destroyed", "destroy"],
  ["must be replaced", "replace"],
  ["will be updated in-place", "update"],
  ["will be created", "create"],
  ["will be imported", "import"],
  ["will be read during apply", "read"],
];

function slackEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function code(value) {
  return `\`${slackEscape(value)}\``;
}

function truncateText(value, maxLength = 2800) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 20)}\n...truncated`;
}

function parseAction(phrase) {
  const match = ACTION_PHRASES.find(([terraformPhrase]) =>
    phrase.includes(terraformPhrase),
  );
  return match?.[1] ?? null;
}

function extractResourceType(address) {
  const withoutIndexes = address.replace(/\[[^\]]+\]/g, "");
  const parts = withoutIndexes.split(".");
  return parts.length >= 2 ? parts.at(-2) : withoutIndexes;
}

function parsePlanCounts(terraformPlan) {
  const match = terraformPlan.match(
    /Plan:\s+(\d+)\s+to add,\s+(\d+)\s+to change,\s+(\d+)\s+to destroy\./,
  );

  if (!match) {
    return null;
  }

  return {
    add: Number(match[1]),
    change: Number(match[2]),
    destroy: Number(match[3]),
  };
}

function parseTerraformPlan(terraformPlan) {
  const resourceActions = [];

  for (const line of terraformPlan.split(/\r?\n/)) {
    const match = line.match(/^\s*#\s+(.+?)\s+((?:will|must) be .+?)\s*$/);
    if (!match) {
      continue;
    }

    const address = match[1].replace(/\s+\([^)]+\)$/, "");
    const action = parseAction(match[2]);

    if (!action || action === "read" || address.startsWith("data.")) {
      continue;
    }

    resourceActions.push({
      action,
      address,
      type: extractResourceType(address),
    });
  }

  return {
    counts: parsePlanCounts(terraformPlan),
    resourceActions,
  };
}

function formatPlanCounts(counts, resourceActions) {
  if (counts) {
    return `${counts.add} add, ${counts.change} change, ${counts.destroy} destroy`;
  }

  if (resourceActions.length > 0) {
    return `${resourceActions.length} resource action${
      resourceActions.length === 1 ? "" : "s"
    }`;
  }

  return "changes detected";
}

function summarizeByType(resourceActions) {
  const summaries = new Map();

  for (const resource of resourceActions) {
    const counts = summaries.get(resource.type) ?? new Map();
    counts.set(resource.action, (counts.get(resource.action) ?? 0) + 1);
    summaries.set(resource.type, counts);
  }

  return [...summaries.entries()]
    .map(([type, counts]) => ({
      type,
      total: [...counts.values()].reduce((sum, count) => sum + count, 0),
      actions: ACTION_ORDER.filter((action) => counts.has(action)).map(
        (action) => `${counts.get(action)} ${action}`,
      ),
    }))
    .sort((left, right) => {
      if (right.total !== left.total) {
        return right.total - left.total;
      }
      return left.type.localeCompare(right.type);
    });
}

function formatTypeSummary(resourceActions) {
  const typeSummaries = summarizeByType(resourceActions);

  if (typeSummaries.length === 0) {
    return "No resource headers were found in the sanitized plan output.";
  }

  const visible = typeSummaries
    .slice(0, MAX_TYPE_LINES)
    .map(({ type, actions }) => `- ${code(type)}: ${actions.join(", ")}`);
  const hiddenCount = typeSummaries.length - visible.length;

  if (hiddenCount > 0) {
    visible.push(
      `- ...and ${hiddenCount} more resource type${hiddenCount === 1 ? "" : "s"}`,
    );
  }

  return visible.join("\n");
}

function formatResourceActions(resourceActions) {
  if (resourceActions.length === 0) {
    return "Open the workflow run for the full sanitized plan.";
  }

  const visible = resourceActions
    .slice(0, MAX_RESOURCE_LINES)
    .map((resource) => `- ${resource.action} ${code(resource.address)}`);
  const hiddenCount = resourceActions.length - visible.length;

  if (hiddenCount > 0) {
    visible.push(
      `- ...and ${hiddenCount} more resource action${hiddenCount === 1 ? "" : "s"}`,
    );
  }

  return visible.join("\n");
}

function parsePullRequestNumberFromCommitMessage(message) {
  const mergeMatch = message.match(/Merge pull request #(\d+)/);
  if (mergeMatch) {
    return Number(mergeMatch[1]);
  }

  const squashMatch = message.match(/\(#(\d+)\)(?:\s|$)/);
  if (squashMatch) {
    return Number(squashMatch[1]);
  }

  return null;
}

function readEventPayload(eventPath) {
  if (!eventPath || !existsSync(eventPath)) {
    return {};
  }

  return JSON.parse(readFileSync(eventPath, "utf8"));
}

function httpsJson(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...headers,
    };

    if (payload !== undefined) {
      requestHeaders["Content-Type"] = "application/json; charset=utf-8";
      requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = request(url, { method, headers: requestHeaders }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let parsed = null;
        if (raw !== "") {
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            reject(
              new Error(`Invalid JSON response from ${url}: ${error.message}`),
            );
            return;
          }
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(
            new Error(
              `HTTP ${res.statusCode ?? "unknown"} from ${url}: ${raw}`,
            ),
          );
          return;
        }

        resolve(parsed);
      });
    });

    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

async function getPullRequestByNumber({ apiUrl, githubToken, repo, number }) {
  if (!number) {
    return null;
  }

  const pr = await httpsJson(`${apiUrl}/repos/${repo}/pulls/${number}`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
  };
}

async function findAssociatedPullRequest({
  apiUrl,
  githubToken,
  repo,
  sha,
  eventPayload,
}) {
  const commitMessage = eventPayload.head_commit?.message ?? "";
  const fallbackNumber = parsePullRequestNumberFromCommitMessage(commitMessage);

  if (!githubToken || !repo) {
    return null;
  }

  if (sha) {
    try {
      const prs = await httpsJson(
        `${apiUrl}/repos/${repo}/commits/${sha}/pulls`,
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      const pr = prs.find((candidate) => candidate.merged_at) ?? prs[0];
      if (pr) {
        return {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
        };
      }
    } catch (error) {
      console.warn(
        `Could not look up PRs associated with ${sha}: ${error.message}`,
      );
    }
  }

  try {
    return await getPullRequestByNumber({
      apiUrl,
      githubToken,
      repo,
      number: fallbackNumber,
    });
  } catch (error) {
    console.warn(`Could not look up PR #${fallbackNumber}: ${error.message}`);
    return null;
  }
}

function triggerDescription({ eventName, actor, sha }) {
  if (eventName === "workflow_dispatch") {
    return `Manual workflow dispatch by ${actor || "unknown"}`;
  }
  if (eventName === "push") {
    return `Push to main at ${sha?.slice(0, 7) || "unknown commit"}`;
  }
  return eventName || "GitHub Actions";
}

function buildSlackPayload({
  channel,
  stackLabel,
  targetEnvironment,
  workflowName,
  runNumber,
  runUrl,
  commitUrl,
  sha,
  actor,
  trigger,
  pullRequest,
  parsedPlan,
}) {
  const planSummary = formatPlanCounts(
    parsedPlan.counts,
    parsedPlan.resourceActions,
  );
  const prText = pullRequest
    ? `<${pullRequest.url}|#${pullRequest.number} ${slackEscape(pullRequest.title)}>`
    : slackEscape(trigger);
  const commitText =
    commitUrl && sha
      ? `<${commitUrl}|${sha.slice(0, 7)}>`
      : (sha?.slice(0, 7) ?? "unknown");
  const workflowText =
    workflowName && runNumber
      ? `<${runUrl}|${slackEscape(workflowName)} #${slackEscape(runNumber)}>`
      : `<${runUrl}|Workflow run>`;

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Terraform apply pending: ${slackEscape(stackLabel)}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Target:* ${code(targetEnvironment)}`,
          `*Plan:* ${slackEscape(planSummary)}`,
          `*Source:* ${prText}`,
          `*Commit:* ${commitText}`,
          `*Workflow:* ${workflowText}`,
          `*Triggered by:* ${slackEscape(actor || "unknown")}`,
        ].join("\n"),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateText(
          `*Resource type counts:*\n${formatTypeSummary(parsedPlan.resourceActions)}`,
        ),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateText(
          `*Resource actions:*\n${formatResourceActions(parsedPlan.resourceActions)}`,
        ),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: slackEscape(
            "Resource addresses only; attribute values are intentionally omitted from Slack.",
          ),
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open workflow run" },
          url: runUrl,
        },
      ],
    },
  ];

  if (pullRequest) {
    blocks.at(-1).elements.push({
      type: "button",
      text: { type: "plain_text", text: "Open merged PR" },
      url: pullRequest.url,
    });
  }

  if (commitUrl) {
    blocks.at(-1).elements.push({
      type: "button",
      text: { type: "plain_text", text: "Open commit" },
      url: commitUrl,
    });
  }

  return {
    channel,
    text: `Terraform apply pending: ${slackEscape(stackLabel)} (${slackEscape(planSummary)})`,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}

async function postToSlack({ slackToken, payload }) {
  const response = await httpsJson("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken}`,
    },
    body: payload,
  });

  if (response?.ok !== true) {
    throw new Error(
      `Slack chat.postMessage failed: ${response?.error ?? "unknown"}`,
    );
  }
}

async function main(env = process.env) {
  const planFile = env.TERRAFORM_PLAN_FILE || DEFAULT_PLAN_FILE;
  const terraformPlan = readFileSync(planFile, "utf8");
  const eventPayload = readEventPayload(env.GITHUB_EVENT_PATH);
  const repo = env.GITHUB_REPOSITORY;
  const serverUrl = env.GITHUB_SERVER_URL || "https://github.com";
  const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
  const sha = env.GITHUB_SHA || eventPayload.after || "";
  const runUrl = `${serverUrl}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  const commitUrl = sha ? `${serverUrl}/${repo}/commit/${sha}` : "";
  const stackLabel = env.TERRAFORM_STACK_LABEL || "terraform";
  const targetEnvironment = env.TERRAFORM_TARGET_ENVIRONMENT || "production";
  const slackChannel = env.SLACK_CHANNEL || DEFAULT_SLACK_CHANNEL;

  if (!env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is required");
  }

  const pullRequest = await findAssociatedPullRequest({
    apiUrl,
    githubToken: env.GITHUB_TOKEN,
    repo,
    sha,
    eventPayload,
  });

  const payload = buildSlackPayload({
    channel: slackChannel,
    stackLabel,
    targetEnvironment,
    workflowName: env.GITHUB_WORKFLOW,
    runNumber: env.GITHUB_RUN_NUMBER,
    runUrl,
    commitUrl,
    sha,
    actor: env.GITHUB_ACTOR,
    trigger: triggerDescription({
      eventName: env.GITHUB_EVENT_NAME,
      actor: env.GITHUB_ACTOR,
      sha,
    }),
    pullRequest,
    parsedPlan: parseTerraformPlan(terraformPlan),
  });

  await postToSlack({ slackToken: env.SLACK_BOT_TOKEN, payload });
  console.log(`Posted Terraform apply summary to ${slackChannel}.`);
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
  buildSlackPayload,
  formatResourceActions,
  formatTypeSummary,
  parsePullRequestNumberFromCommitMessage,
  parseTerraformPlan,
  summarizeByType,
};
