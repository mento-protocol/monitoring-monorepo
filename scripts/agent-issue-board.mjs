#!/usr/bin/env node
/**
 * Keep the agent issue labels authoritative while projecting that state onto
 * the repo's GitHub Projects workboard.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GH_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const DEFAULT_PROJECT_OWNER = "mento-protocol";
export const DEFAULT_PROJECT_NUMBER = 12;

const STATE_TRANSITIONS = {
  ready: {
    addLabels: ["agent-ready"],
    removeLabels: ["agent-active", "in-pr", "needs-grooming"],
    statusOptions: ["Todo", "Ready"],
  },
  active: {
    addLabels: ["agent-active"],
    removeLabels: ["agent-ready", "in-pr", "needs-grooming"],
    statusOptions: ["In Progress"],
  },
  review: {
    addLabels: ["in-pr"],
    removeLabels: ["agent-ready", "agent-active", "needs-grooming"],
    statusOptions: ["In Review", "Review", "In Progress"],
  },
  grooming: {
    addLabels: ["needs-grooming"],
    removeLabels: ["agent-ready", "agent-active", "in-pr"],
    statusOptions: ["Needs Grooming", "Blocked", "Todo"],
  },
  done: {
    addLabels: [],
    removeLabels: ["agent-ready", "agent-active", "in-pr"],
    statusOptions: ["Done"],
  },
};

const OPTIONAL_PROJECT_FIELDS = {
  agent: "Agent",
  branch: "Branch",
  claimId: "Claim ID",
  claimedAt: "Claimed At",
  pr: "PR",
};

function usage() {
  return `Usage:
  pnpm issue:claim --count 3 [--agent codex] [--branch <name>] [--dry-run]
  pnpm issue:claim --issue 901 --issue 902 [--agent claude]
  pnpm issue:review --pr 123 --issue 901 [--issue 902]
  pnpm issue:release --issue 901 [--needs-grooming]
  pnpm issue:board sync [--dry-run]

Options:
  --repo <owner/name>              Repository to operate on (default: ${DEFAULT_REPO})
  --project-owner <owner>          Project owner (default: ${DEFAULT_PROJECT_OWNER})
  --project-number <number>        Project number (default: ${DEFAULT_PROJECT_NUMBER})
  --issue, --issues <numbers>      Issue number(s), comma-separated or repeated
  --count <number>                 Number of ready issues to claim (default: 1)
  --agent <name>                   Agent/session label for comments and project fields
  --branch <name>                  Branch/worktree hint for comments and project fields
  --pr <number-or-url>             Pull request number or URL for review moves
  --needs-grooming                 Release issues to needs-grooming instead of agent-ready
  --no-comment                     Do not post issue comments for claim/review/release
  --dry-run                        Print mutations without applying them
  --json                           Print machine-readable command results
`;
}

function unique(values) {
  return [...new Set(values)];
}

export function parseIssueNumbers(values) {
  const numbers = [];
  for (const value of values) {
    for (const part of String(value).split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const match =
        trimmed.match(/^#?(\d+)$/) ??
        trimmed.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Invalid issue reference: ${trimmed}`);
      }
      numbers.push(Number(match[1]));
    }
  }
  return unique(numbers);
}

function parsePr(value) {
  const trimmed = String(value).trim();
  const match =
    trimmed.match(/^#?(\d+)$/) ??
    trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (!match) throw new Error(`Invalid PR reference: ${trimmed}`);
  return Number(match[1]);
}

function defaultAgent(env = process.env) {
  return env.AGENT_NAME ?? env.CODEX_AGENT_NAME ?? env.USER ?? "agent";
}

export function parseArgs(argv, env = process.env) {
  const options = {
    command: "help",
    repo: env.AGENT_ISSUE_REPO ?? DEFAULT_REPO,
    projectOwner: env.AGENT_WORKBOARD_OWNER ?? DEFAULT_PROJECT_OWNER,
    projectNumber: Number(
      env.AGENT_WORKBOARD_PROJECT_NUMBER ?? DEFAULT_PROJECT_NUMBER,
    ),
    count: 1,
    issueValues: [],
    issues: [],
    agent: defaultAgent(env),
    branch: env.AGENT_BRANCH ?? "",
    pr: null,
    dryRun: false,
    json: false,
    comment: true,
    releaseState: "ready",
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    options.command = args.shift();
    if (options.command === "board") {
      options.command = args.shift() ?? "help";
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readValue = () => {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case "--repo":
        options.repo = readValue();
        break;
      case "--project-owner":
        options.projectOwner = readValue();
        break;
      case "--project-number":
        options.projectNumber = Number(readValue());
        break;
      case "--count":
        options.count = Number(readValue());
        break;
      case "--issue":
      case "--issues":
        options.issueValues.push(readValue());
        break;
      case "--agent":
        options.agent = readValue();
        break;
      case "--branch":
        options.branch = readValue();
        break;
      case "--pr":
        options.pr = parsePr(readValue());
        break;
      case "--needs-grooming":
        options.releaseState = "grooming";
        break;
      case "--no-comment":
        options.comment = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.command = "help";
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        options.issueValues.push(arg);
    }
  }

  if (!Number.isInteger(options.projectNumber) || options.projectNumber <= 0) {
    throw new Error("--project-number must be a positive integer");
  }
  if (!Number.isInteger(options.count) || options.count <= 0) {
    throw new Error("--count must be a positive integer");
  }

  options.issues = parseIssueNumbers(options.issueValues);
  return options;
}

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=@#-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatGh(args) {
  return `gh ${args.map((arg) => quoteArg(String(arg))).join(" ")}`;
}

function runGh(args, { dryRun = false, mutates = false } = {}) {
  if (dryRun && mutates) {
    process.stderr.write(`[dry-run] ${formatGh(args)}\n`);
    return Promise.resolve("");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failed = false;

    function fail(message) {
      if (failed) return;
      failed = true;
      child.kill();
      reject(new Error(message));
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > GH_OUTPUT_MAX_BYTES) {
        fail(
          `gh ${args.join(" ")} stdout exceeded ${GH_OUTPUT_MAX_BYTES} bytes`,
        );
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > GH_OUTPUT_MAX_BYTES) {
        fail(
          `gh ${args.join(" ")} stderr exceeded ${GH_OUTPUT_MAX_BYTES} bytes`,
        );
        return;
      }
      stderr += chunk;
    });
    child.on("error", (err) => {
      fail(`gh ${args.join(" ")} failed: ${err.message}`);
    });
    child.on("close", (status) => {
      if (failed) return;
      if (status !== 0) {
        reject(
          new Error(
            `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

async function ghJson(args, opts = {}) {
  const stdout = await runGh(args, opts);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function ghGraphql(query, variables = {}, opts = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    const flag = typeof value === "number" ? "-F" : "-f";
    args.push(flag, `${key}=${value}`);
  }
  return ghJson(args, opts);
}

export function selectStatusOption(statusOptions, state) {
  const transition = STATE_TRANSITIONS[state];
  if (!transition) throw new Error(`Unknown state: ${state}`);
  for (const name of transition.statusOptions) {
    const option = statusOptions.find((candidate) => candidate.name === name);
    if (option) return option;
  }
  throw new Error(
    `Project Status field is missing one of: ${transition.statusOptions.join(", ")}`,
  );
}

export function labelsForState(state) {
  const transition = STATE_TRANSITIONS[state];
  if (!transition) throw new Error(`Unknown state: ${state}`);
  return transition;
}

function labelNames(issue) {
  return new Set((issue.labels ?? []).map((label) => label.name));
}

function stateFromLabels(issue) {
  const labels = labelNames(issue);
  if (labels.has("in-pr")) return "review";
  if (labels.has("agent-active")) return "active";
  if (labels.has("agent-ready")) return "ready";
  if (labels.has("needs-grooming")) return "grooming";
  return null;
}

export function isClaimable(issue) {
  const labels = labelNames(issue);
  return (
    issue.state === "OPEN" &&
    labels.has("agent-ready") &&
    !labels.has("agent-active") &&
    !labels.has("in-pr")
  );
}

async function getGitBranch() {
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn("git", ["branch", "--show-current"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let error = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status === 0) resolve(output);
        else reject(new Error(error));
      });
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function listReadyIssues(options) {
  const search =
    "is:issue is:open label:agent-ready -label:agent-active -label:in-pr";
  const issues = await ghJson([
    "issue",
    "list",
    "-R",
    options.repo,
    "--search",
    search,
    "--limit",
    String(options.count),
    "--json",
    "id,number,title,url,labels,state,projectItems",
  ]);
  return issues ?? [];
}

async function listIssuesByLabel(options, label) {
  const issues = await ghJson([
    "issue",
    "list",
    "-R",
    options.repo,
    "--search",
    `is:issue is:open label:${label}`,
    "--limit",
    "100",
    "--json",
    "id,number,title,url,labels,state,projectItems",
  ]);
  return issues ?? [];
}

async function getIssue(options, number) {
  return ghJson([
    "issue",
    "view",
    String(number),
    "-R",
    options.repo,
    "--json",
    "id,number,title,url,labels,state,projectItems",
  ]);
}

async function getPrIssues(options) {
  if (!options.pr) return [];
  const pr = await ghJson([
    "pr",
    "view",
    String(options.pr),
    "-R",
    options.repo,
    "--json",
    "number,url,title,headRefName,closingIssuesReferences",
  ]);
  const issues = pr?.closingIssuesReferences ?? [];
  return issues.map((issue) => issue.number).filter(Number.isInteger);
}

async function getProject(options) {
  const response = await ghGraphql(
    `query($org:String!,$number:Int!){
      organization(login:$org){
        projectV2(number:$number){
          id
          title
          url
          fields(first:50){
            nodes{
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }`,
    { org: options.projectOwner, number: options.projectNumber },
  );
  const project = response?.data?.organization?.projectV2;
  if (!project) {
    throw new Error(
      `Project ${options.projectOwner}/${options.projectNumber} was not found`,
    );
  }
  const fields = project.fields.nodes.filter(Boolean);
  const statusField = fields.find((field) => field.name === "Status");
  if (!statusField?.options) {
    throw new Error("Project must have a single-select Status field");
  }
  return {
    id: project.id,
    title: project.title,
    url: project.url,
    fields,
    statusField,
    statusOptions: statusField.options,
  };
}

function findField(project, name) {
  return project.fields.find((field) => field.name === name);
}

function findIssueProjectItemInNodes(nodes, project) {
  for (const item of nodes ?? []) {
    if (item?.id && item?.project?.id === project.id) return item.id;
    if (item?.id && item?.project?.title === project.title) return item.id;
  }
  return null;
}

async function findIssueProjectItem(options, issue, project) {
  const localItem = findIssueProjectItemInNodes(issue.projectItems, project);
  if (localItem) return localItem;

  const response = await ghGraphql(
    `query($issue:ID!){
      node(id:$issue){
        ... on Issue {
          projectItems(first:50) {
            nodes {
              id
              project {
                id
                title
              }
            }
          }
        }
      }
    }`,
    { issue: issue.id },
  );
  return findIssueProjectItemInNodes(
    response?.data?.node?.projectItems?.nodes,
    project,
  );
}

async function readProjectTextField(options, itemId, fieldId) {
  const response = await ghGraphql(
    `query($item:ID!){
      node(id:$item){
        ... on ProjectV2Item {
          fieldValues(first:50) {
            nodes {
              ... on ProjectV2ItemFieldTextValue {
                text
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { item: itemId },
  );
  const values = response?.data?.node?.fieldValues?.nodes ?? [];
  const match = values.find((value) => value?.field?.id === fieldId);
  return match?.text ?? null;
}

async function verifyClaimOwnership(options, project, itemId, issue, metadata) {
  if (options.dryRun) return;
  const claimField = findField(project, OPTIONAL_PROJECT_FIELDS.claimId);
  if (claimField?.dataType !== "TEXT") return;
  const claimId = await readProjectTextField(options, itemId, claimField.id);
  if (claimId !== metadata.claimId) {
    throw new Error(
      `Issue #${issue.number} claim was overwritten; project Claim ID is ${claimId ?? "<empty>"} instead of ${metadata.claimId}`,
    );
  }
}

export function chooseUntriedCandidate(candidates, triedNumbers) {
  for (const item of candidates ?? []) {
    if (!triedNumbers.has(item.number)) return item;
  }
  return null;
}

async function addIssueToProject(options, project, issue) {
  const response = await ghGraphql(
    `mutation($project:ID!,$content:ID!){
      addProjectV2ItemById(input:{projectId:$project,contentId:$content}){
        item { id }
      }
    }`,
    { project: project.id, content: issue.id },
    { dryRun: options.dryRun, mutates: true },
  );
  return response?.data?.addProjectV2ItemById?.item?.id;
}

async function ensureProjectItem(options, project, issue) {
  const existing = await findIssueProjectItem(options, issue, project);
  if (existing) return existing;
  if (options.dryRun) return "dry-run-project-item";
  try {
    return await addIssueToProject(options, project, issue);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already|exists|duplicate/i.test(message)) throw err;
    const refreshed = await getIssue(options, issue.number);
    const refreshedItem = await findIssueProjectItem(
      options,
      refreshed,
      project,
    );
    if (refreshedItem) return refreshedItem;
    throw err;
  }
}

async function updateSingleSelect(options, project, itemId, fieldId, optionId) {
  await ghGraphql(
    `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$project
        itemId:$item
        fieldId:$field
        value:{singleSelectOptionId:$option}
      }) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: fieldId, option: optionId },
    { dryRun: options.dryRun, mutates: true },
  );
}

async function clearProjectField(options, project, itemId, fieldId) {
  await ghGraphql(
    `mutation($project:ID!,$item:ID!,$field:ID!){
      clearProjectV2ItemFieldValue(input:{
        projectId:$project
        itemId:$item
        fieldId:$field
      }) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: fieldId },
    { dryRun: options.dryRun, mutates: true },
  );
}

async function updateTextField(options, project, itemId, fieldId, text) {
  if (text === undefined) return;
  if (text === null || text === "") {
    await clearProjectField(options, project, itemId, fieldId);
    return;
  }
  await ghGraphql(
    `mutation($project:ID!,$item:ID!,$field:ID!,$text:String!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$project
        itemId:$item
        fieldId:$field
        value:{text:$text}
      }) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: fieldId, text },
    { dryRun: options.dryRun, mutates: true },
  );
}

async function updateDateField(options, project, itemId, fieldId, date) {
  if (date === undefined) return;
  if (date === null || date === "") {
    await clearProjectField(options, project, itemId, fieldId);
    return;
  }
  await ghGraphql(
    `mutation($project:ID!,$item:ID!,$field:ID!,$date:Date!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$project
        itemId:$item
        fieldId:$field
        value:{date:$date}
      }) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: fieldId, date },
    { dryRun: options.dryRun, mutates: true },
  );
}

async function updateProjectFields(options, project, itemId, state, metadata) {
  const statusOption = selectStatusOption(project.statusOptions, state);
  await updateSingleSelect(
    options,
    project,
    itemId,
    project.statusField.id,
    statusOption.id,
  );

  const textValues = {};
  if (Object.hasOwn(metadata, "agent")) {
    textValues[OPTIONAL_PROJECT_FIELDS.agent] = metadata.agent;
  }
  if (Object.hasOwn(metadata, "branch")) {
    textValues[OPTIONAL_PROJECT_FIELDS.branch] = metadata.branch;
  }
  if (Object.hasOwn(metadata, "claimId")) {
    textValues[OPTIONAL_PROJECT_FIELDS.claimId] = metadata.claimId;
  }
  if (Object.hasOwn(metadata, "pr")) {
    textValues[OPTIONAL_PROJECT_FIELDS.pr] = metadata.pr
      ? `#${metadata.pr}`
      : "";
  }
  for (const [fieldName, value] of Object.entries(textValues)) {
    const field = findField(project, fieldName);
    if (field?.dataType === "TEXT") {
      await updateTextField(options, project, itemId, field.id, value);
    }
  }

  const claimedAtField = findField(project, OPTIONAL_PROJECT_FIELDS.claimedAt);
  if (
    claimedAtField?.dataType === "DATE" &&
    Object.hasOwn(metadata, "claimedAt")
  ) {
    await updateDateField(
      options,
      project,
      itemId,
      claimedAtField.id,
      metadata.claimedAt ? metadata.claimedAt.slice(0, 10) : "",
    );
  }
}

async function editIssueLabels(options, issue, state) {
  const transition = labelsForState(state);
  const existingLabels = labelNames(issue);
  const addLabels = transition.addLabels.filter(
    (label) => !existingLabels.has(label),
  );
  const removeLabels = transition.removeLabels.filter((label) =>
    existingLabels.has(label),
  );
  if (addLabels.length === 0 && removeLabels.length === 0) return;

  const args = ["issue", "edit", String(issue.number), "-R", options.repo];
  if (addLabels.length > 0) {
    args.push("--add-label", addLabels.join(","));
  }
  if (removeLabels.length > 0) {
    args.push("--remove-label", removeLabels.join(","));
  }
  await runGh(args, { dryRun: options.dryRun, mutates: true });
}

export function buildClaimComment(metadata, issue) {
  const lines = [
    `Agent claim: ${metadata.agent} claimed #${issue.number} for implementation.`,
    "",
    `Claim ID: ${metadata.claimId}`,
  ];
  if (metadata.branch) lines.push(`Branch: ${metadata.branch}`);
  lines.push(`Claimed at: ${metadata.claimedAt}`);
  return lines.join("\n");
}

function buildReviewComment(metadata, issue) {
  const lines = [
    `Moved to review: #${issue.number} is now represented by PR #${metadata.pr}.`,
  ];
  if (metadata.branch) lines.push(`Branch: ${metadata.branch}`);
  return lines.join("\n");
}

function buildReleaseComment(metadata, issue, state) {
  const label = state === "grooming" ? "needs-grooming" : "agent-ready";
  return `Released agent claim: #${issue.number} is back in ${label}.`;
}

async function commentOnIssue(options, issue, body) {
  if (!options.comment) return;
  await runGh(
    [
      "issue",
      "comment",
      String(issue.number),
      "-R",
      options.repo,
      "--body",
      body,
    ],
    { dryRun: options.dryRun, mutates: true },
  );
}

function claimIdFor(options, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${options.agent}-${stamp}-${suffix}`;
}

async function transitionIssue(options, project, issue, state, metadata) {
  await editIssueLabels(options, issue, state);
  const itemId = await ensureProjectItem(options, project, issue);
  await updateProjectFields(options, project, itemId, state, metadata);
  return itemId;
}

function claimMetadata(options, branch) {
  return {
    agent: options.agent,
    branch,
    claimId: claimIdFor(options),
    claimedAt: new Date().toISOString(),
    pr: options.pr,
  };
}

async function claimIssue(options, project, issue, metadata) {
  if (!isClaimable(issue)) {
    throw new Error(
      `Issue #${issue.number} is not claimable; expected open agent-ready without agent-active/in-pr`,
    );
  }
  const itemId = await transitionIssue(
    options,
    project,
    issue,
    "active",
    metadata,
  );
  if (options.dryRun) {
    await commentOnIssue(options, issue, buildClaimComment(metadata, issue));
    return { number: issue.number, title: issue.title, state: "active" };
  }
  await verifyClaimOwnership(options, project, itemId, issue, metadata);
  const verified = await getIssue(options, issue.number);
  if (!labelNames(verified).has("agent-active")) {
    throw new Error(`Issue #${issue.number} did not retain agent-active`);
  }
  if (
    labelNames(verified).has("agent-ready") ||
    labelNames(verified).has("in-pr")
  ) {
    throw new Error(`Issue #${issue.number} has conflicting state labels`);
  }
  await commentOnIssue(
    options,
    verified,
    buildClaimComment(metadata, verified),
  );
  return { number: verified.number, title: verified.title, state: "active" };
}

async function claim(options) {
  const branch = options.branch || (await getGitBranch());
  const project = await getProject(options);
  const results = [];
  if (options.issues.length > 0) {
    for (const number of options.issues) {
      const issue = await getIssue(options, number);
      results.push(
        await claimIssue(
          options,
          project,
          issue,
          claimMetadata(options, branch),
        ),
      );
    }
    return results;
  }

  const triedNumbers = new Set();
  const candidateLimit = Math.min(Math.max(options.count * 5, 10), 100);
  while (results.length < options.count) {
    const candidates = await listReadyIssues({
      ...options,
      count: candidateLimit,
    });
    const candidate = chooseUntriedCandidate(candidates, triedNumbers);
    if (!candidate) break;
    triedNumbers.add(candidate.number);
    const issue = await getIssue(options, candidate.number);
    if (!isClaimable(issue)) continue;
    results.push(
      await claimIssue(options, project, issue, claimMetadata(options, branch)),
    );
  }

  if (results.length === 0) {
    throw new Error("No claimable agent-ready issues found");
  }
  return results;
}

async function review(options) {
  const project = await getProject(options);
  const inferredIssues =
    options.issues.length > 0 ? [] : await getPrIssues(options);
  const issueNumbers =
    options.issues.length > 0 ? options.issues : inferredIssues;
  if (issueNumbers.length === 0) {
    throw new Error(
      "review requires --issue/--issues or a PR with closing issues",
    );
  }
  const branch = options.branch || (await getGitBranch());
  const metadata = {
    agent: options.agent,
    branch,
    claimId: "",
    claimedAt: "",
    pr: options.pr,
  };
  const results = [];
  for (const number of issueNumbers) {
    const issue = await getIssue(options, number);
    await transitionIssue(options, project, issue, "review", metadata);
    if (options.pr) {
      await commentOnIssue(options, issue, buildReviewComment(metadata, issue));
    }
    results.push({ number: issue.number, title: issue.title, state: "review" });
  }
  return results;
}

async function release(options) {
  if (options.issues.length === 0) {
    throw new Error("release requires --issue/--issues");
  }
  const project = await getProject(options);
  const metadata = {
    agent: "",
    branch: "",
    claimId: "",
    claimedAt: "",
    pr: null,
  };
  const results = [];
  for (const number of options.issues) {
    const issue = await getIssue(options, number);
    await transitionIssue(
      options,
      project,
      issue,
      options.releaseState,
      metadata,
    );
    await commentOnIssue(
      options,
      issue,
      buildReleaseComment(metadata, issue, options.releaseState),
    );
    results.push({
      number: issue.number,
      title: issue.title,
      state: options.releaseState,
    });
  }
  return results;
}

async function sync(options) {
  const project = await getProject(options);
  const byNumber = new Map();
  for (const label of [
    "agent-ready",
    "agent-active",
    "in-pr",
    "needs-grooming",
  ]) {
    for (const issue of await listIssuesByLabel(options, label)) {
      byNumber.set(issue.number, issue);
    }
  }

  const results = [];
  for (const issue of byNumber.values()) {
    const state = stateFromLabels(issue);
    if (!state) continue;
    const itemId = await ensureProjectItem(options, project, issue);
    await updateProjectFields(options, project, itemId, state, {});
    results.push({ number: issue.number, title: issue.title, state });
  }
  return results;
}

function renderResults(results) {
  if (results.length === 0) return "No issues changed.";
  return results
    .map((issue) => `#${issue.number} ${issue.state}: ${issue.title}`)
    .join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(usage());
    return;
  }

  let results;
  switch (options.command) {
    case "claim":
      results = await claim(options);
      break;
    case "review":
      results = await review(options);
      break;
    case "release":
      results = await release(options);
      break;
    case "sync":
      results = await sync(options);
      break;
    default:
      throw new Error(`Unknown command: ${options.command}\n\n${usage()}`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ issues: results }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderResults(results)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
