import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  ALLOWED_ASSOCIATIONS,
  GITHUB_API_URL,
  MAX_REVIEW_INPUT_BYTES,
  REQUEST_WORKFLOW_NAME,
  REQUEST_WORKFLOW_PATH,
  REVIEW_COMMAND,
  REVIEW_INPUT_RELATIVE_PATH,
  REVIEW_TARGET_RELATIVE_PATH,
  assertRepository,
  boundedString,
  canonicalBranch,
  canonicalHead,
  canonicalPrNumber,
  fail,
  githubHeaders,
  readJsonResponse,
  trustedGithubApiUrl,
  trustedWorkflowRef,
  validateRemotePr,
} from "./claude-review-contract.mjs";

function eventReviewRequest(eventName, event, repository) {
  assertRepository(event?.repository?.full_name, repository);
  const defaultBranch = String(event?.repository?.default_branch ?? "");
  const workflowRef = trustedWorkflowRef(repository, defaultBranch);
  if (eventName === "workflow_run") {
    const run = event?.workflow_run;
    if (
      event?.action !== "completed" ||
      run?.name !== REQUEST_WORKFLOW_NAME ||
      run?.path !== REQUEST_WORKFLOW_PATH ||
      run?.event !== "pull_request" ||
      run?.conclusion !== "success"
    ) {
      fail("workflow_run is not the Claude review dispatcher");
    }
    assertRepository(run?.head_repository?.full_name, repository);
    if (
      run?.actor?.type !== "User" ||
      run?.actor?.login === "dependabot[bot]"
    ) {
      fail("machine-authored pull requests are not auto-reviewed");
    }
    return {
      prNumber: null,
      requestedHead: canonicalHead(run?.head_sha),
      requestedHeadRef: canonicalBranch(
        run?.head_branch,
        "dispatcher head branch",
      ),
      defaultBranch,
      workflowRef,
    };
  }

  let trigger;
  if (eventName === "issue_comment") {
    if (event?.action !== "created")
      fail("issue comment review request was not created");
    if (!event?.issue?.pull_request)
      fail("review request is not on a pull request");
    trigger = event.comment;
  } else if (eventName === "pull_request_review_comment") {
    if (event?.action !== "created")
      fail("review comment request was not created");
    trigger = event.comment;
  } else if (eventName === "pull_request_review") {
    if (event?.action !== "submitted")
      fail("pull request review was not submitted");
    trigger = event.review;
  } else {
    fail("unsupported Claude review event");
  }
  if (!ALLOWED_ASSOCIATIONS.has(String(trigger?.author_association ?? ""))) {
    fail("review request author is not an OWNER or MEMBER");
  }
  if (trigger?.user?.type !== "User")
    fail("review request author is not human");
  if (!REVIEW_COMMAND.test(String(trigger?.body ?? ""))) {
    fail("event does not contain an @claude review request");
  }
  return {
    prNumber: canonicalPrNumber(
      eventName === "issue_comment"
        ? event?.issue?.number
        : event?.pull_request?.number,
    ),
    requestedHead: null,
    requestedHeadRef: null,
    defaultBranch,
    workflowRef,
  };
}

export async function resolveReviewContext({
  eventName,
  event,
  repository,
  githubToken,
  fetchImpl = fetch,
  apiUrl = GITHUB_API_URL,
}) {
  const repo = assertRepository(repository);
  const request = eventReviewRequest(eventName, event, repo);
  const trustedApiUrl = trustedGithubApiUrl(apiUrl);
  const headers = githubHeaders(githubToken);
  let remote;
  let prNumber = request.prNumber;
  if (request.requestedHeadRef !== null) {
    const owner = repo.split("/")[0];
    const lookup = new URL(`${trustedApiUrl}/repos/${repo}/pulls`);
    lookup.searchParams.set("state", "open");
    lookup.searchParams.set("head", `${owner}:${request.requestedHeadRef}`);
    lookup.searchParams.set("per_page", "100");
    const candidates = await readJsonResponse(
      await fetchImpl(lookup, { headers }),
      "dispatcher pull request lookup",
    );
    if (!Array.isArray(candidates) || candidates.length !== 1) {
      fail("dispatcher head must resolve to exactly one open pull request");
    }
    [remote] = candidates;
    prNumber = canonicalPrNumber(remote?.number);
  } else {
    remote = await readJsonResponse(
      await fetchImpl(`${trustedApiUrl}/repos/${repo}/pulls/${prNumber}`, {
        headers,
      }),
      "pull request lookup",
    );
  }
  const context = validateRemotePr(
    remote,
    repo,
    prNumber,
    request.defaultBranch,
  );
  if (
    request.requestedHeadRef !== null &&
    request.requestedHeadRef !== context.headRef
  ) {
    fail("dispatcher branch does not match the current pull request head");
  }
  if (
    request.requestedHead !== null &&
    request.requestedHead !== context.headSha
  ) {
    fail("dispatcher head does not match the current pull request head");
  }
  return { ...context, workflowRef: request.workflowRef };
}

function exactWorkspacePath(env, envName, relativePath) {
  const workspace = resolve(
    boundedString(env.GITHUB_WORKSPACE, "GitHub workspace", 2000),
  );
  const expected = resolve(workspace, relativePath);
  const actual = resolve(boundedString(env[envName], `${envName} path`, 2000));
  if (actual !== expected) fail(`${envName} is outside its trusted path`);
  return { workspace, path: actual };
}

function runGitCommand(targetDir, args) {
  const result = spawnSync("git", args, {
    cwd: targetDir,
    encoding: "utf8",
    maxBuffer: MAX_REVIEW_INPUT_BYTES + 1,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    fail("trusted review input git command failed");
  }
  const stdout = String(result.stdout ?? "");
  if (Buffer.byteLength(stdout, "utf8") > MAX_REVIEW_INPUT_BYTES) {
    fail("trusted review input git output exceeds its bound");
  }
  return stdout;
}

export function writeReviewInputFile({
  context,
  env,
  runGitImpl = runGitCommand,
}) {
  const repository = assertRepository(context?.repository);
  const prNumber = canonicalPrNumber(context?.prNumber);
  const baseSha = canonicalHead(context?.baseSha);
  const headSha = canonicalHead(context?.headSha);
  const { path: targetDir } = exactWorkspacePath(
    env,
    "CLAUDE_REVIEW_TARGET_DIR",
    REVIEW_TARGET_RELATIVE_PATH,
  );
  const targetStats = lstatSync(targetDir);
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    fail("review target must be a regular directory");
  }
  const { path: reviewInputFile } = exactWorkspacePath(
    env,
    "CLAUDE_REVIEW_INPUT_FILE",
    REVIEW_INPUT_RELATIVE_PATH,
  );
  const git = (...args) => runGitImpl(targetDir, args);
  const checkedOutHead = canonicalHead(git("rev-parse", "HEAD").trim());
  if (checkedOutHead !== headSha)
    fail("review target is not the requested head");
  const mergeBase = canonicalHead(git("merge-base", baseSha, headSha).trim());
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  if (status !== "") fail("review target worktree is not clean");
  const commits = git(
    "log",
    "--no-decorate",
    "--no-show-signature",
    "--format=%H%x09%P%x09%an%x09%ad%x09%s",
    "--date=iso-strict",
    `${mergeBase}..${headSha}`,
  );
  const diffStat = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--stat",
    mergeBase,
    headSha,
    "--",
  );
  const diff = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=80",
    mergeBase,
    headSha,
    "--",
  );
  const packet = [
    "MENTO CLAUDE REVIEW INPUT v1",
    `REPOSITORY: ${repository}`,
    `PR: ${prNumber}`,
    `BASE TIP: ${baseSha}`,
    `MERGE BASE: ${mergeBase}`,
    `HEAD: ${headSha}`,
    "STATUS:",
    "(clean)",
    "COMMITS:",
    commits || "(none)\n",
    "DIFF STAT:",
    diffStat || "(none)\n",
    "DIFF:",
    diff || "(none)\n",
    "END MENTO CLAUDE REVIEW INPUT v1",
    "",
  ].join("\n");
  if (Buffer.byteLength(packet, "utf8") > MAX_REVIEW_INPUT_BYTES) {
    fail("trusted review input exceeds its bound");
  }
  mkdirSync(dirname(reviewInputFile), { recursive: false, mode: 0o700 });
  const inputDirStats = lstatSync(dirname(reviewInputFile));
  if (!inputDirStats.isDirectory() || inputDirStats.isSymbolicLink()) {
    fail("review input directory is not trusted");
  }
  writeFileSync(reviewInputFile, packet, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return reviewInputFile;
}
