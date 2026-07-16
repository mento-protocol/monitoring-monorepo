#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertNoSecretLikeContent,
  buildBoundedReviewPrompts,
  createReviewInputCollector,
  MAX_REVIEW_PROMPT_BYTES,
  readBoundedRegularFile,
  readSafeEvidenceFile,
  reviewPromptOutputPaths,
  secretLikeReason,
  serializeSafeUntrackedFile,
  sensitivePathReason,
  splitReviewBundle,
  utf8Size,
  writeReviewPromptOutputs,
} from "./agent-autoreview-core.mjs";

const unicodeBundle = `# Branch Diff\n${
  "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n+" +
  "界".repeat(50_000) +
  "\nTAIL_SENTINEL\n"
}`;
const chunks = splitReviewBundle(unicodeBundle, 32_000);
assert.ok(chunks.length > 1);
assert.equal(
  chunks.map((chunk) => chunk.content).join(""),
  unicodeBundle,
  "chunking must preserve every original byte in order",
);
assert.ok(chunks.every((chunk) => utf8Size(chunk.content) <= 32_000));
assert.ok(
  chunks
    .slice(1)
    .some((chunk) => chunk.context.includes("original marker is `+`")),
  "long diff-line continuations retain their marker",
);

const largeBundle = `${unicodeBundle}\n${"plain context\n".repeat(55_000)}`;
const prompts = buildBoundedReviewPrompts(largeBundle, (chunk, position) =>
  [
    "review header",
    position ? `pass ${position.index}/${position.total}` : "single pass",
    chunk.context,
    "# Change Bundle",
    chunk.content,
  ].join("\n"),
);
assert.ok(prompts.length > 1);
assert.ok(
  prompts.every((prompt) => utf8Size(prompt) <= MAX_REVIEW_PROMPT_BYTES),
);
assert.ok(prompts.some((prompt) => prompt.includes("TAIL_SENTINEL")));

const inputCollector = createReviewInputCollector(10, "test review input");
inputCollector.add("first part", "1234");
inputCollector.add("second part", "5678");
assert.equal(inputCollector.sizeBytes(), 10);
assert.equal(inputCollector.remainingBytes(), 0);
assert.equal(inputCollector.toString(), "1234\n\n5678");
assert.throws(
  () => inputCollector.add("overflow", "x"),
  /test review input exceeds the 10-byte aggregate limit while adding overflow/,
);

assert.throws(
  () =>
    buildBoundedReviewPrompts(
      "x".repeat(MAX_REVIEW_PROMPT_BYTES * 8),
      (chunk, position) =>
        `header ${position?.index ?? 1}/${position?.total ?? 1}\n${chunk.context}\n${chunk.content}`,
    ),
  /more than 8 bounded passes|requires \d+ bounded passes/,
);

const secret = ["gh", "p_", "A".repeat(36)].join("");
assert.match(secretLikeReason(`token=${secret}`), /credential-like token/);
assert.throws(
  () => assertNoSecretLikeContent("fixture", `token=${secret}`),
  /refusing to include secret-like content/,
);
const temporaryAwsAccessKey = ["ASIA", "A".repeat(16)].join("");
assert.match(
  secretLikeReason(`aws_access_key_id = ${temporaryAwsAccessKey}`),
  /credential-like token/,
  "temporary AWS access-key IDs are rejected",
);
const awsSecretAccessKey = ["aws", "secret", "value", "A".repeat(24)].join("-");
assert.match(
  secretLikeReason(`aws_secret_access_key = ${awsSecretAccessKey}`),
  /literal AWS credential assignment/,
  "AWS secret-access-key assignments are rejected",
);
const awsSessionToken = ["aws", "session", "token", "A".repeat(32)].join("-");
assert.match(
  secretLikeReason(`aws_session_token = ${awsSessionToken}`),
  /literal AWS credential assignment/,
  "AWS session-token assignments are rejected",
);
assert.equal(
  secretLikeReason("aws_secret_access_key = ${AWS_SECRET_ACCESS_KEY}"),
  null,
  "AWS environment placeholders are safe evidence",
);
assert.match(
  secretLikeReason(
    `client_secret=${["live", "credential", "value"].join("-")}`,
  ),
  /literal credential assignment/,
);
assert.equal(
  secretLikeReason('api_key = "${SERVICE_API_KEY}"'),
  null,
  "environment placeholders are safe evidence",
);
assert.equal(
  secretLikeReason('api_key = "test-api-key-placeholder"'),
  null,
  "explicit placeholder tokens are safe evidence",
);
const latestCredential = ["latest", "production", "credential", "123456"].join(
  "-",
);
assert.match(
  secretLikeReason(`api_key = "${latestCredential}"`),
  /literal credential assignment/,
  "placeholder words must not match arbitrary substrings",
);
const unquotedCredential = ["live", "credential", "value", "123456"].join("");
assert.match(
  secretLikeReason(`api_key=${unquotedCredential}`),
  /literal credential assignment/,
  "unquoted configuration literals are rejected",
);
assert.match(
  secretLikeReason(`+api_key=${unquotedCredential} # rotated later`),
  /literal credential assignment/,
  "diff-prefixed unquoted configuration literals are rejected",
);
const npmRegistryCredential = ["npm", "_", "A".repeat(36)].join("");
assert.match(
  secretLikeReason(`//registry.npmjs.org/:_authToken=${npmRegistryCredential}`),
  /literal registry credential assignment/,
  "registry-scoped npm credentials are rejected",
);
assert.match(
  secretLikeReason(
    `+//registry.npmjs.org/:_authToken=${npmRegistryCredential}`,
  ),
  /literal registry credential assignment/,
  "diff-prefixed registry-scoped npm credentials are rejected",
);
assert.equal(
  secretLikeReason("//registry.npmjs.org/:_authToken=${NPM_TOKEN}"),
  null,
  "registry-scoped environment placeholders are safe evidence",
);
assert.equal(
  secretLikeReason("const secret = generateSecureToken();"),
  null,
  "ordinary code expressions are not unquoted credential literals",
);
assert.equal(
  sensitivePathReason("config/.env.production"),
  "sensitive configuration path",
);
assert.equal(sensitivePathReason("config/.env.production.example"), null);
assert.equal(
  sensitivePathReason(".aws/credentials.example"),
  null,
  "example credential paths rely on content scanning",
);
assert.equal(sensitivePathReason(".docker/config.json"), "credential store");
assert.equal(
  sensitivePathReason(".config/gcloud/application_default_credentials.json"),
  "credential store",
);
assert.equal(
  sensitivePathReason("nested/.docker/config.json"),
  "credential store",
);

const root = mkdtempSync(path.join(tmpdir(), "agent-autoreview-core-test."));
const repo = path.join(root, "repo");
const trusted = path.join(root, "trusted");
mkdirSync(repo);
mkdirSync(trusted);
writeFileSync(path.join(repo, "prompt.md"), "review this\n");
writeFileSync(path.join(repo, "bounded.txt"), "12345678");
assert.equal(
  readBoundedRegularFile(path.join(repo, "bounded.txt"), "bounded fixture", 8)
    .data.length,
  8,
);
writeFileSync(path.join(repo, "bounded.txt"), "123456789");
assert.throws(
  () =>
    readBoundedRegularFile(
      path.join(repo, "bounded.txt"),
      "bounded fixture",
      8,
    ),
  /too large to review safely/,
);
writeFileSync(path.join(repo, "script.sh"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(repo, "script.sh"), 0o644);
assert.match(
  serializeSafeUntrackedFile(repo, "script.sh"),
  /^# Untracked File\npath: "script\.sh"\nmode: 100644\n/,
);
chmodSync(path.join(repo, "script.sh"), 0o755);
assert.match(
  serializeSafeUntrackedFile(repo, "script.sh"),
  /^# Untracked File\npath: "script\.sh"\nmode: 100755\n/,
);
writeFileSync(path.join(trusted, "feedback-state.json"), '{"findings":[]}\n');
const promptEvidence = readSafeEvidenceFile({
  repo,
  rawPath: "prompt.md",
  label: "--prompt-file",
});
assert.equal(promptEvidence.displayPath, "prompt.md");
const trustedEvidence = readSafeEvidenceFile({
  repo,
  rawPath: path.join(trusted, "feedback-state.json"),
  label: "--dataset",
  trustedRoot: trusted,
  allowTrustedRoot: true,
});
assert.equal(trustedEvidence.displayPath, "trusted/feedback-state.json");
assert.throws(
  () =>
    readSafeEvidenceFile({
      repo,
      rawPath: "../trusted/feedback-state.json",
      label: "--dataset",
    }),
  /repo-relative path/,
);
symlinkSync(path.join(repo, "prompt.md"), path.join(repo, "linked.md"));
assert.throws(
  () =>
    readSafeEvidenceFile({
      repo,
      rawPath: "linked.md",
      label: "--prompt-file",
    }),
  /symlinked/,
);

const promptIndex = path.join(root, "autoreview-prompt.md");
const outputs = writeReviewPromptOutputs(promptIndex, ["pass one", "pass two"]);
assert.equal(outputs.length, 3);
assert.match(
  readFileSync(promptIndex, "utf8"),
  /split across 2 bounded passes/,
);
assert.equal(readFileSync(outputs[1], "utf8"), "pass one");
assert.equal(readFileSync(outputs[2], "utf8"), "pass two");
assert.deepEqual(reviewPromptOutputPaths("/published/review.md", 2), [
  "/published/review.md",
  "/published/review.pass-01-of-02.md",
  "/published/review.pass-02-of-02.md",
]);

rmSync(root, { recursive: true, force: true });
console.log("agent-autoreview core tests passed");
