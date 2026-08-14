import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  CLAUDE_APP_TOKEN_AUDIENCE,
  CLAUDE_APP_TOKEN_EXCHANGE_URL,
  CLAUDE_OIDC_ISSUER,
  GITHUB_API_URL,
  REVIEW_WORKFLOW_PATH,
  assertRepository,
  bearerAuthorization,
  boundedString,
  buildClaudeReviewAttestationArtifactName,
  buildReviewBody,
  canonicalCommentId,
  canonicalHead,
  canonicalPrNumber,
  fail,
  githubHeaders,
  readJsonResponse,
  trustedGithubApiUrl,
  trustedWorkflowRef,
  validateRemotePr,
  validateStructuredReview,
} from "./claude-review-contract.mjs";

function decodeJwtPayload(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part))
    fail("OIDC token is malformed");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    fail("OIDC token payload is malformed");
  }
}

export function validateOidcClaims(
  token,
  { repository, workflowRef, runId, runAttempt },
) {
  if (!/^[1-9]\d*$/.test(String(runId ?? ""))) {
    fail("workflow run ID is invalid");
  }
  if (!/^[1-9]\d*$/.test(String(runAttempt ?? ""))) {
    fail("workflow run attempt is invalid");
  }
  const claims = decodeJwtPayload(token);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== CLAUDE_OIDC_ISSUER) fail("OIDC issuer is invalid");
  if (claims.aud !== CLAUDE_APP_TOKEN_AUDIENCE)
    fail("OIDC audience is invalid");
  if (claims.repository !== repository) fail("OIDC repository is invalid");
  if (claims.workflow_ref !== workflowRef)
    fail("OIDC workflow identity is invalid");
  if (String(claims.run_id ?? "") !== String(runId))
    fail("OIDC run identity is invalid");
  if (String(claims.run_attempt ?? "") !== String(runAttempt)) {
    fail("OIDC run attempt is invalid");
  }
  if (
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.nbf) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat > now + 30 ||
    claims.nbf > now + 30 ||
    claims.exp <= now ||
    claims.exp - claims.iat > 600
  ) {
    fail("OIDC token time bounds are invalid");
  }
  return claims;
}

async function requestOidcToken(env, fetchImpl, repository, workflowRef) {
  const requestUrl = new URL(
    boundedString(env.ACTIONS_ID_TOKEN_REQUEST_URL, "OIDC request URL", 2000),
  );
  requestUrl.searchParams.set("audience", CLAUDE_APP_TOKEN_AUDIENCE);
  const requestCredential = boundedString(
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    "OIDC request token",
    4000,
  );
  const data = await readJsonResponse(
    await fetchImpl(requestUrl, {
      headers: {
        Authorization: bearerAuthorization(requestCredential),
      },
    }),
    "OIDC token request",
  );
  const oidcCredential = boundedString(data?.value, "OIDC token", 20_000);
  validateOidcClaims(oidcCredential, {
    repository,
    workflowRef,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  });
  return oidcCredential;
}

async function exchangeAppToken(oidcCredential, fetchImpl) {
  const data = await readJsonResponse(
    await fetchImpl(CLAUDE_APP_TOKEN_EXCHANGE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: bearerAuthorization(oidcCredential),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        permissions: {
          pull_requests: "read",
          issues: "write",
        },
      }),
    }),
    "Claude App token exchange",
  );
  const candidates = [data?.token, data?.app_token].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (candidates.length !== 1)
    fail("Claude App token exchange response is invalid");
  return boundedString(candidates[0], "Claude App token", 20_000);
}

function verifyClaudeComment(comment, expectedBody, expectedId = null) {
  if (comment?.user?.login !== "claude[bot]" || comment?.user?.type !== "Bot") {
    fail("published review does not have the Claude App identity");
  }
  if (comment?.body !== expectedBody)
    fail("published review body does not match");
  if (!Number.isSafeInteger(comment?.id) || comment.id < 1) {
    fail("published review comment ID is invalid");
  }
  if (expectedId !== null && comment.id !== expectedId) {
    fail("persisted review comment ID does not match");
  }
}

async function findExistingClaudeComment({
  apiUrl,
  repository,
  prNumber,
  body,
  headers,
  fetchImpl,
}) {
  const matches = [];
  const pageSize = 100;
  const maxPages = 100;
  for (let page = 1; page <= maxPages; page += 1) {
    const comments = await readJsonResponse(
      await fetchImpl(
        `${apiUrl}/repos/${repository}/issues/${prNumber}/comments?per_page=${pageSize}&page=${page}`,
        { headers },
      ),
      "existing Claude review lookup",
    );
    if (!Array.isArray(comments)) {
      fail("existing Claude review lookup returned invalid comments");
    }
    for (const comment of comments) {
      if (
        comment?.user?.login === "claude[bot]" &&
        comment?.user?.type === "Bot" &&
        comment?.body === body
      ) {
        canonicalCommentId(comment.id);
        matches.push(comment);
      }
    }
    if (comments.length < pageSize) {
      if (matches.length > 1) {
        fail("multiple exact Claude review comments already exist");
      }
      return matches[0] ?? null;
    }
  }
  fail("existing Claude review lookup exceeded the pagination bound");
}

function canonicalWorkflowRef(value, repository) {
  const workflowRef = String(value ?? "");
  const prefix = `${repository}/${REVIEW_WORKFLOW_PATH}@refs/heads/`;
  if (!workflowRef.startsWith(prefix)) fail("trusted workflow ref is invalid");
  const defaultBranch = workflowRef.slice(prefix.length);
  if (trustedWorkflowRef(repository, defaultBranch) !== workflowRef) {
    fail("trusted workflow ref is invalid");
  }
  return { workflowRef, defaultBranch };
}

export async function publishClaudeReview({
  review,
  context,
  env = process.env,
  fetchImpl = fetch,
}) {
  const validatedReview = validateStructuredReview(review);
  const repo = assertRepository(context?.repository);
  const prNumber = canonicalPrNumber(context?.prNumber);
  const expectedHead = canonicalHead(context?.headSha);
  const { workflowRef, defaultBranch } = canonicalWorkflowRef(
    context?.workflowRef,
    repo,
  );
  if (env.GITHUB_WORKFLOW_REF !== workflowRef) {
    fail("publisher is not running from the trusted workflow ref");
  }
  const body = buildReviewBody(validatedReview, {
    prNumber,
    headSha: expectedHead,
  });
  const apiUrl = trustedGithubApiUrl(env.GITHUB_API_URL ?? GITHUB_API_URL);
  let appCredential = null;
  let result = null;
  let failure = null;
  try {
    const oidcCredential = await requestOidcToken(
      env,
      fetchImpl,
      repo,
      workflowRef,
    );
    appCredential = await exchangeAppToken(oidcCredential, fetchImpl);
    const headers = githubHeaders(appCredential);
    const remote = await readJsonResponse(
      await fetchImpl(`${apiUrl}/repos/${repo}/pulls/${prNumber}`, { headers }),
      "current-head recheck",
    );
    const current = validateRemotePr(remote, repo, prNumber, defaultBranch);
    if (current.headSha !== expectedHead)
      fail("pull request head changed before publish");

    const existing = await findExistingClaudeComment({
      apiUrl,
      repository: repo,
      prNumber,
      body,
      headers,
      fetchImpl,
    });
    let commentId;
    if (existing === null) {
      const posted = await readJsonResponse(
        await fetchImpl(`${apiUrl}/repos/${repo}/issues/${prNumber}/comments`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        }),
        "Claude review publish",
      );
      verifyClaudeComment(posted, body);
      commentId = posted.id;
    } else {
      verifyClaudeComment(existing, body);
      commentId = existing.id;
    }
    const persisted = await readJsonResponse(
      await fetchImpl(`${apiUrl}/repos/${repo}/issues/comments/${commentId}`, {
        headers,
      }),
      "Claude review verification read",
    );
    verifyClaudeComment(persisted, body, commentId);
    result = { commentId, body };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (appCredential !== null) {
      try {
        const revoked = await fetchImpl(`${apiUrl}/installation/token`, {
          method: "DELETE",
          headers: githubHeaders(appCredential),
        });
        if (!revoked?.ok) fail("Claude App token revocation failed");
      } catch (error) {
        if (failure === null) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
  }
  if (failure !== null) throw failure;
  return result;
}

function trustedAttestationFilePath(env) {
  const runnerTemp = resolve(
    boundedString(env.RUNNER_TEMP, "runner temporary directory", 2000),
  );
  const expected = resolve(runnerTemp, "claude-review/attestation.json");
  const actual = resolve(
    boundedString(
      env.CLAUDE_REVIEW_ATTESTATION_FILE,
      "clean-review attestation file",
      2000,
    ),
  );
  if (actual !== expected) {
    fail("clean-review attestation file is outside its trusted path");
  }
  return actual;
}

function writeClaudeReviewAttestationFile({ result, context, env }) {
  const artifactName = buildClaudeReviewAttestationArtifactName({
    prNumber: context.prNumber,
    headSha: context.headSha,
    commentId: result.commentId,
    body: result.body,
  });
  const attestationFile = trustedAttestationFilePath(env);
  const sentinel = `${JSON.stringify({
    version: 1,
    repository: assertRepository(context.repository),
    pr: Number(canonicalPrNumber(context.prNumber)),
    head: canonicalHead(context.headSha),
    comment_id: Number(canonicalCommentId(result.commentId)),
    body_sha256: createHash("sha256").update(result.body, "utf8").digest("hex"),
    workflow_ref: canonicalWorkflowRef(context.workflowRef, context.repository)
      .workflowRef,
    run_id: canonicalPrNumber(env.GITHUB_RUN_ID),
    run_attempt: canonicalPrNumber(env.GITHUB_RUN_ATTEMPT),
  })}\n`;
  mkdirSync(dirname(attestationFile), { recursive: true, mode: 0o700 });
  writeFileSync(attestationFile, sentinel, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { artifactName, attestationFile };
}

export async function publishClaudeReviewWithSentinel({
  review,
  context,
  env = process.env,
  fetchImpl = fetch,
}) {
  const result = await publishClaudeReview({ review, context, env, fetchImpl });
  if (review.verdict !== "clean") {
    return { ...result, artifactName: null, attestationFile: null };
  }
  return {
    ...result,
    ...writeClaudeReviewAttestationFile({ result, context, env }),
  };
}
