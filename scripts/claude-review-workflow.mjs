#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canonicalCommentId,
  fail,
  parseStructuredReview,
  readStructuredReviewFile,
  writeStructuredReviewFile,
} from "./claude-review-contract.mjs";
import {
  resolveReviewContext,
  writeReviewInputFile,
} from "./claude-review-context.mjs";
import { publishClaudeReviewWithSentinel } from "./claude-review-publisher.mjs";

export {
  CLAUDE_APP_TOKEN_AUDIENCE,
  CLAUDE_APP_TOKEN_EXCHANGE_URL,
  CLAUDE_OIDC_ISSUER,
  MAX_REVIEW_COMMENT_BYTES,
  assertBoundedReviewCommentBody,
  buildClaudeReviewAttestationArtifactName,
  buildCleanReviewEnvelope,
  buildReviewBody,
  readStructuredReviewFile,
  serializeStructuredReview,
  validateStructuredReview,
  writeStructuredReviewFile,
} from "./claude-review-contract.mjs";
export {
  resolveReviewContext,
  writeReviewInputFile,
} from "./claude-review-context.mjs";
export {
  publishClaudeReview,
  publishClaudeReviewWithSentinel,
  validateOidcClaims,
} from "./claude-review-publisher.mjs";

function writeOutputs(context) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) fail("GITHUB_OUTPUT is missing");
  for (const [key, value] of Object.entries({
    repository: context.repository,
    pr: context.prNumber,
    head: context.headSha,
    head_ref: context.headRef,
    base: context.baseSha,
    base_ref: context.baseRef,
    workflow_ref: context.workflowRef,
  })) {
    appendFileSync(outputPath, `${key}=${value}\n`, "utf8");
  }
}

function writePublishOutputs(result, env) {
  const outputPath = env.GITHUB_OUTPUT;
  if (!outputPath) fail("GITHUB_OUTPUT is missing");
  const bodySha256 = createHash("sha256")
    .update(result.body, "utf8")
    .digest("hex");
  for (const [key, value] of Object.entries({
    comment_id: canonicalCommentId(result.commentId),
    body_sha256: bodySha256,
    attestation_artifact: result.artifactName ?? "",
  })) {
    appendFileSync(outputPath, `${key}=${value}\n`, "utf8");
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "resolve-context") {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const context = await resolveReviewContext({
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
      repository: process.env.GITHUB_REPOSITORY,
      githubToken: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    writeOutputs(context);
    process.stdout.write(
      `Resolved PR #${context.prNumber} at ${context.headSha}.\n`,
    );
    return;
  }
  if (command === "write-review") {
    const review = parseStructuredReview(
      process.env.CLAUDE_STRUCTURED_REVIEW ?? "",
    );
    writeStructuredReviewFile(review, process.env);
    process.stdout.write("Validated structured Claude review artifact.\n");
    return;
  }
  if (command === "write-input") {
    writeReviewInputFile({
      context: {
        repository: process.env.CLAUDE_REVIEW_REPOSITORY,
        prNumber: process.env.CLAUDE_REVIEW_PR,
        baseSha: process.env.CLAUDE_REVIEW_BASE,
        headSha: process.env.CLAUDE_REVIEW_HEAD,
      },
      env: process.env,
    });
    process.stdout.write("Prepared bounded Claude review input.\n");
    return;
  }
  if (command === "publish") {
    const context = {
      repository: process.env.CLAUDE_REVIEW_REPOSITORY,
      prNumber: process.env.CLAUDE_REVIEW_PR,
      headSha: process.env.CLAUDE_REVIEW_HEAD,
      workflowRef: process.env.CLAUDE_REVIEW_WORKFLOW_REF,
    };
    const review = readStructuredReviewFile(process.env);
    const result = await publishClaudeReviewWithSentinel({ review, context });
    writePublishOutputs(result, process.env);
    process.stdout.write(
      `Published verified Claude review comment ${result.commentId}.\n`,
    );
    return;
  }
  fail(
    "usage: claude-review-workflow.mjs <resolve-context|write-input|write-review|publish>",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
