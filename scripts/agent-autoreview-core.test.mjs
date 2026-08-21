#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertNoSecretLikeContent,
  assertStableFileRead,
  assertStableEvidencePathAfterRead,
  buildBoundedReviewPrompts,
  createReviewInputCollector,
  isWithin,
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

const containmentRoot = path.join(tmpdir(), "autoreview-reviewed-repo");
assert.equal(isWithin(containmentRoot, containmentRoot), true);
assert.equal(
  isWithin(
    path.join(containmentRoot, "tools", "bin", "codex"),
    containmentRoot,
  ),
  true,
);
assert.equal(
  isWithin(
    path.join(containmentRoot, "..tools", "bin", "codex"),
    containmentRoot,
  ),
  true,
  "descendant names beginning with two dots are not parent traversal",
);
assert.equal(
  isWithin(path.join(containmentRoot, "...", "evidence.md"), containmentRoot),
  true,
  "descendant names beginning with more than two dots remain inside the root",
);
assert.equal(isWithin(path.dirname(containmentRoot), containmentRoot), false);
assert.equal(
  isWithin(
    path.join(
      path.dirname(containmentRoot),
      "autoreview-reviewed-repo-sibling",
    ),
    containmentRoot,
  ),
  false,
  "a real parent segment still escapes the root",
);

const stableReadStat = {
  dev: 1,
  ino: 2,
  mode: 0o100644,
  nlink: 1,
  size: 128,
  mtimeMs: 10,
  ctimeMs: 20,
};
assert.doesNotThrow(() =>
  assertStableFileRead(stableReadStat, { ...stableReadStat }, "stable fixture"),
);
assert.throws(
  () =>
    assertStableFileRead(
      stableReadStat,
      { ...stableReadStat, ctimeMs: 21 },
      "mutated fixture",
    ),
  /changed while it was being read/,
  "in-place evidence mutation is rejected even when the inode is unchanged",
);
assert.throws(
  () =>
    assertStableFileRead(
      stableReadStat,
      { ...stableReadStat, nlink: 2 },
      "hard-linked fixture",
    ),
  /changed while it was being read/,
  "link-count changes are part of the bounded-read stability invariant",
);

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

// Redaction accept-shape: a credential-shaped token on a hunk's REMOVED side is
// acceptable only when the same hunk's added side carries the same line with
// that token replaced by placeholder vocabulary. Every fixture below builds its
// credential-shaped literal by joining fragments so this corpus itself never
// carries a bundle-refusable literal.
const otherSecret = ["gh", "s_", "B".repeat(36)].join("");
const redactionHunk = (removedLines, addedLines) =>
  [
    "diff --git a/scripts/fixture.test.mjs b/scripts/fixture.test.mjs",
    "--- a/scripts/fixture.test.mjs",
    "+++ b/scripts/fixture.test.mjs",
    "@@ -1,3 +1,3 @@",
    " const before = 1;",
    ...removedLines.map((line) => `-${line}`),
    ...addedLines.map((line) => `+${line}`),
    " const after = 2;",
  ].join("\n");

// The accept-shape applies only to text a caller vouches is a git-generated
// patch, so every assertion in this block scans in that mode explicitly. The
// supplemental-input controls at the end of the block cover the closed default.
const diffScan = (text) => secretLikeReason(text, { gitDiff: true });

const wordPlaceholderRedaction = redactionHunk(
  [`const sample = "${secret}";`],
  ['const sample = "redacted-fixture-token";'],
);
assert.equal(
  diffScan(wordPlaceholderRedaction),
  null,
  "a removal replaced in-place by placeholder vocabulary is a redaction, not an exfiltration",
);
assert.doesNotThrow(() =>
  assertNoSecretLikeContent("redaction", wordPlaceholderRedaction, {
    gitDiff: true,
  }),
);
assert.equal(
  diffScan(
    redactionHunk(
      [`const sample = "${secret}";`],
      ['const sample = "<redacted>";'],
    ),
  ),
  null,
  "angle-bracket placeholders are recognized replacement vocabulary",
);
assert.equal(
  diffScan(
    redactionHunk(
      [`const sample = "${secret}";`],
      ['const sample = "${SAMPLE_TOKEN}";'],
    ),
  ),
  null,
  "an env-reference placeholder is recognized replacement vocabulary",
);
assert.equal(
  diffScan(
    redactionHunk(
      [`const pair = ["${secret}", "${otherSecret}"];`],
      ['const pair = ["<redacted>", "<redacted>"];'],
    ),
  ),
  null,
  "every credential-shaped span on the removed line must be replaced, and all of them may be",
);

const sharedPlaceholderRemovals = redactionHunk(
  [`const sample = "${secret}";`, `const sample = "${otherSecret}";`],
  ['const sample = "redacted-fixture-token";'],
);
assert.match(
  diffScan(sharedPlaceholderRemovals),
  /credential-like token/,
  "one placeholder redacts one removal, so a second credential-bearing removal is an unreplaced deletion",
);
assert.throws(
  () =>
    assertNoSecretLikeContent("shared placeholder", sharedPlaceholderRemovals, {
      gitDiff: true,
    }),
  /refusing to include secret-like content/,
);
assert.equal(
  diffScan(
    redactionHunk(
      [`const sample = "${secret}";`, `const sample = "${otherSecret}";`],
      [
        'const sample = "redacted-fixture-token";',
        'const sample = "redacted-fixture-token";',
      ],
    ),
  ),
  null,
  "two removals redacted by two placeholder lines are both replacements",
);

const unreplacedRemoval = redactionHunk([`const sample = "${secret}";`], []);
assert.match(
  diffScan(unreplacedRemoval),
  /credential-like token/,
  "a removal with no replacement stays refused",
);
assert.throws(
  () =>
    assertNoSecretLikeContent("unreplaced removal", unreplacedRemoval, {
      gitDiff: true,
    }),
  /refusing to include secret-like content/,
);
const swappedLiteral = redactionHunk(
  [`const sample = "${secret}";`],
  [`const sample = "${otherSecret}";`],
);
assert.match(
  diffScan(swappedLiteral),
  /credential-like token/,
  "a removal replaced by a different credential-shaped literal stays refused",
);
assert.throws(
  () =>
    assertNoSecretLikeContent("swapped literal", swappedLiteral, {
      gitDiff: true,
    }),
  /refusing to include secret-like content/,
);
assert.match(
  diffScan(
    redactionHunk(
      [`const sample = "${secret}";`],
      ['const sample = "9f3c1a2b4d5e6f708192a3b4";'],
    ),
  ),
  /credential-like token/,
  "an opaque replacement that is not placeholder vocabulary stays refused",
);
assert.match(
  diffScan(
    redactionHunk(
      [`const sample = "${secret}";`],
      ['const renamed = "redacted-fixture-token";'],
    ),
  ),
  /credential-like token/,
  "the line outside the credential span must match exactly, so a rewritten line stays refused",
);
assert.match(
  diffScan(
    redactionHunk(
      [`const sample = "${secret}";`],
      ['const sample = "redacted" + resolveSuffix();'],
    ),
  ),
  /credential-like token/,
  "a replacement expression that merely starts with placeholder vocabulary stays refused",
);
assert.match(
  diffScan(
    [
      "@@ -1,2 +1,2 @@",
      `-const sample = "${secret}";`,
      " const tail = 1;",
      "@@ -20,2 +20,2 @@",
      '-const sample = "old-value-placeholder";',
      '+const sample = "redacted-fixture-token";',
    ].join("\n"),
  ),
  /credential-like token/,
  "a placeholder replacement in a different hunk does not redact this removal",
);
assert.match(
  diffScan(
    [
      "@@ -1,3 +1,3 @@",
      ` const sample = "${secret}";`,
      "-const other = 1;",
      '+const other = "redacted-token";',
    ].join("\n"),
  ),
  /credential-like token/,
  "a context line carrying the literal is not a removal and stays refused",
);
assert.match(
  diffScan(
    redactionHunk(
      ['const sample = "redacted-fixture-token";'],
      [`const sample = "${secret}";`],
    ),
  ),
  /credential-like token/,
  "add-side detection is untouched: replacing a placeholder with a literal stays refused",
);
assert.match(
  diffScan(`-const sample = "${secret}";`),
  /credential-like token/,
  "a removal-shaped line outside any hunk stays refused",
);
assert.match(
  diffScan(
    [
      "@@ -1,2 +1,2 @@",
      " const before = 1;",
      "diff --git a/scripts/other.mjs b/scripts/other.mjs",
      `-const sample = "${secret}";`,
      '+const sample = "redacted-fixture-token";',
    ].join("\n"),
  ),
  /credential-like token/,
  "a new file header closes the hunk, so the lines after it are not hunk removals",
);

// Supplemental input — `--prompt`, prompt files, datasets, branch names, refs —
// is arbitrary text the author controls, so it never earns the accept-shape. A
// diff-shaped prompt carrying a real credential is refused on the closed
// default, which is what `secretLikeReason` and `assertNoSecretLikeContent` do
// when no caller vouches for the text.
const promptShapedAsRedaction = [
  "@@ -1 +1 @@",
  `-sample ${secret}`,
  "+sample <redacted>",
].join("\n");
assert.equal(
  diffScan(promptShapedAsRedaction),
  null,
  "negative control: this fixture is accepted when it is scanned as a git diff",
);
assert.match(
  secretLikeReason(promptShapedAsRedaction),
  /credential-like token/,
  "a diff-shaped supplemental prompt is not a git diff, so the redaction exception does not apply",
);
assert.throws(
  () => assertNoSecretLikeContent("--prompt", promptShapedAsRedaction),
  /refusing to include secret-like content/,
  "assertNoSecretLikeContent defaults to the closed scan, so no call site gets the exception by omission",
);
const promptWithFabricatedFileHeader = [
  "diff --git a/sample.txt b/sample.txt",
  "--- a/sample.txt",
  "+++ b/sample.txt",
  promptShapedAsRedaction,
].join("\n");
assert.match(
  secretLikeReason(promptWithFabricatedFileHeader),
  /credential-like token/,
  "an author who can write a hunk header into a prompt can write a file header too, so neither earns the exception",
);
assert.match(
  secretLikeReason(
    [
      "Please review the following change.",
      promptShapedAsRedaction,
      "Focus on the error handling.",
    ].join("\n"),
  ),
  /credential-like token/,
  "prose wrapped around a redaction-shaped fragment stays refused",
);
assert.match(
  secretLikeReason(wordPlaceholderRedaction),
  /credential-like token/,
  "even a genuine bundle redaction is refused when it arrives as supplemental input",
);

for (const label of [
  "PRIVATE KEY",
  "RSA PRIVATE KEY",
  "DSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "ENCRYPTED PRIVATE KEY",
  "PGP PRIVATE KEY BLOCK",
]) {
  assert.match(
    secretLikeReason(`+-----BEGIN ${label}-----\nopaque-key-body`),
    /private key material/,
    `${label} headers are rejected from diff input`,
  );
}
const paddedPrivateKeyHeader = [
  "-----BEGIN RSA ",
  "PRIVATE KEY-----",
  "   \t",
  "\nopaque-key-body",
].join("");
assert.match(
  secretLikeReason(paddedPrivateKeyHeader),
  /private key material/,
  "private-key headers with trailing horizontal whitespace are rejected",
);
const inlinePrivateKeyLiteral = [
  'const embeddedKey = "-----BEGIN RSA ',
  "PRIVATE KEY-----",
  '\\nopaque-key-body";',
].join("");
assert.match(
  secretLikeReason(inlinePrivateKeyLiteral),
  /private key material/,
  "private-key headers are rejected inside inline JavaScript literals",
);
assert.equal(
  secretLikeReason("documentation mentions -----BEGIN PRIVATE KEY----- only"),
  null,
  "a header name without key-body material is not treated as a credential",
);
const recoveryPhraseWords = [
  "abandon",
  "ability",
  "able",
  "about",
  "above",
  "absent",
  "absorb",
  "abstract",
  "absurd",
  "abuse",
  "access",
  "accident",
  "account",
  "accuse",
  "achieve",
  "acid",
  "acoustic",
  "acquire",
  "across",
  "act",
  "action",
  "actor",
  "actress",
  "actual",
];
const recoveryPhrase = (wordCount) =>
  recoveryPhraseWords.slice(0, wordCount).join(" ");
const reviewerRecoveryPhrase = recoveryPhrase(12);
for (const [assignment, wordCount] of [
  [`MNEMONIC="${reviewerRecoveryPhrase}"`, 12],
  [`walletMnemonic='${recoveryPhrase(15)}'`, 15],
  [`mnemonicPhrase='${recoveryPhrase(12)}'`, 12],
  [`walletMnemonicPhrase='${recoveryPhrase(15)}'`, 15],
  [`mnemonic_words='${recoveryPhrase(18)}'`, 18],
  [`seed_phrase: "${recoveryPhrase(18)}"`, 18],
  [`seedPhrase=\`${recoveryPhrase(21)}\``, 21],
  [`seed='${recoveryPhrase(12)}'`, 12],
  [`walletSeed='${recoveryPhrase(24)}'`, 24],
  [`backupPhrase='${recoveryPhrase(12)}'`, 12],
  [`recoverySeed='${recoveryPhrase(15)}'`, 15],
  [`recovery-phrase: ${recoveryPhrase(24)}`, 24],
  [`recoveryPhrase=${reviewerRecoveryPhrase} # imported wallet`, 12],
]) {
  assert.match(
    secretLikeReason(assignment),
    /literal wallet recovery phrase/,
    `${wordCount}-word recovery phrase assignments are rejected: ${assignment.slice(0, 24)}`,
  );
}
const quotedRecoveryArray = recoveryPhraseWords
  .slice(0, 12)
  .map((word) => JSON.stringify(word))
  .join(", ");
assert.match(
  secretLikeReason(`mnemonic: [${quotedRecoveryArray}]`),
  /literal wallet recovery phrase/,
  "quoted recovery-word arrays are rejected",
);
assert.match(
  secretLikeReason(
    `seedWords: [${recoveryPhraseWords.slice(0, 15).join(", ")}]`,
  ),
  /literal wallet recovery phrase/,
  "plain YAML flow recovery-word arrays are rejected",
);
const yamlRecoveryList = [
  "mnemonic:",
  ...recoveryPhraseWords.slice(0, 12).map((word) => `  - ${word}`),
].join("\n");
assert.match(
  secretLikeReason(yamlRecoveryList),
  /literal wallet recovery phrase/,
  "YAML recovery-word sequences are rejected",
);
assert.match(
  secretLikeReason(
    yamlRecoveryList
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n"),
  ),
  /literal wallet recovery phrase/,
  "unified-diff YAML recovery-word sequences are rejected",
);
for (const blockAssignment of [
  `mnemonic: >-\n  ${reviewerRecoveryPhrase}`,
  `seedPhrase: |\n  ${recoveryPhrase(15)}`,
  `recoveryPhrase: |2-\n    ${recoveryPhrase(18)}`,
]) {
  assert.match(
    secretLikeReason(blockAssignment),
    /literal wallet recovery phrase/,
    "YAML recovery block scalars are rejected",
  );
}
assert.match(
  secretLikeReason(`MNEMONIC=(${reviewerRecoveryPhrase})`),
  /literal wallet recovery phrase/,
  "single-line shell recovery arrays are rejected",
);
assert.match(
  secretLikeReason(
    [
      "SEED_WORDS=(",
      ...recoveryPhraseWords.slice(0, 15).map((word) => `  ${word}`),
      ")",
    ].join("\n"),
  ),
  /literal wallet recovery phrase/,
  "multiline shell recovery arrays are rejected",
);
for (const placeholderAssignment of [
  'MNEMONIC="${MNEMONIC}"',
  "seed_phrase=process.env.SEED_PHRASE",
  'recoveryPhrase: "<redacted>"',
  "walletMnemonic = getMnemonic()",
]) {
  assert.equal(
    secretLikeReason(placeholderAssignment),
    null,
    `recovery phrase placeholders and expressions remain safe: ${placeholderAssignment}`,
  );
}
assert.equal(
  secretLikeReason(
    `mnemonic: [${Array.from({ length: 12 }, (_, index) => `process.env.WORD_${index}`).join(", ")}]`,
  ),
  null,
  "dynamic recovery-word arrays remain safe",
);
assert.equal(
  secretLikeReason("MNEMONIC=(${WORD_1} ${WORD_2})"),
  null,
  "dynamic shell recovery arrays remain safe",
);
assert.equal(
  secretLikeReason(reviewerRecoveryPhrase),
  null,
  "ordinary phrase-shaped prose without a recovery-semantic key is allowed",
);
assert.equal(
  secretLikeReason(`description: "${reviewerRecoveryPhrase}"`),
  null,
  "phrase-shaped prose assigned to a non-recovery key is allowed",
);
assert.equal(
  secretLikeReason(`labels: [${quotedRecoveryArray}]`),
  null,
  "phrase-shaped arrays assigned to a non-recovery key are allowed",
);
assert.equal(
  secretLikeReason(`description: >-\n  ${reviewerRecoveryPhrase}`),
  null,
  "phrase-shaped YAML blocks assigned to a non-recovery key are allowed",
);
assert.equal(
  secretLikeReason(`mnemonic="${recoveryPhrase(11)}"`),
  null,
  "recovery-semantic keys require a standard recovery-phrase word count",
);
assert.equal(
  secretLikeReason(`seedPhrase=${recoveryPhrase(13)}`),
  null,
  "non-standard unquoted word counts are not treated as recovery phrases",
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
const testPrefixedCredential = [
  "test",
  "7f2c",
  "actual",
  "secret",
  "A".repeat(20),
].join("-");
assert.match(
  secretLikeReason(`api_key = "${testPrefixedCredential}"`),
  /literal credential assignment/,
  "a test prefix does not exempt a credential-shaped literal",
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
const vercelCredential = ["vercel", "credential", "A".repeat(24)].join("-");
assert.match(
  secretLikeReason(`VERCEL_TOKEN=${vercelCredential}`),
  /literal (?:generic token|credential) assignment/,
  "literal Vercel token assignments are rejected",
);
const genericSecretKey = ["generic", "secret", "A".repeat(24)].join("-");
assert.match(
  secretLikeReason(`SECRET_KEY=${genericSecretKey}`),
  /literal credential assignment/,
  "literal generic secret-key assignments are rejected",
);
const npmRegistryCredential = ["npm", "_", "A".repeat(36)].join("");
assert.match(
  secretLikeReason(`//registry.npmjs.org/:_authToken=${npmRegistryCredential}`),
  /(?:credential-like token|literal registry credential assignment)/,
  "registry-scoped npm credentials are rejected",
);
assert.match(
  secretLikeReason(
    `+//registry.npmjs.org/:_authToken=${npmRegistryCredential}`,
  ),
  /(?:credential-like token|literal registry credential assignment)/,
  "diff-prefixed registry-scoped npm credentials are rejected",
);
assert.equal(
  secretLikeReason("//registry.npmjs.org/:_authToken=${NPM_TOKEN}"),
  null,
  "registry-scoped environment placeholders are safe evidence",
);
const mixedPlaceholderCredential = ["real", "secret", "value", "123456"].join(
  "-",
);
const mixedPlaceholderValue = `${mixedPlaceholderCredential}\${CREDENTIAL_SUFFIX}`;
assert.match(
  secretLikeReason(`api_key=${JSON.stringify(mixedPlaceholderValue)}`),
  /literal credential assignment/,
  "literal credentials with an environment suffix are not placeholders",
);
assert.equal(
  secretLikeReason("const secret = generateSecureToken();"),
  null,
  "ordinary code expressions are not unquoted credential literals",
);
const stripeLiveKey = ["sk", "live", "A".repeat(24)].join("_");
assert.match(
  secretLikeReason(`stripe=${stripeLiveKey}`),
  /credential-like token/,
  "live Stripe secret keys are rejected",
);
const bearerJwt = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "signaturevalue1234567890",
].join(".");
assert.match(
  secretLikeReason(`Authorization: Bearer ${bearerJwt}`),
  /Bearer JWT/,
  "Authorization bearer JWTs are rejected",
);
const slackWebhook = [
  "https://hooks.slack.com/services",
  "T12345678",
  "B12345678",
  "A".repeat(24),
].join("/");
assert.match(
  secretLikeReason(`webhook=${slackWebhook}`),
  /secret-bearing webhook URL/,
  "Slack webhook URLs are rejected",
);
const discordWebhook = [
  "https://discord.com/api/webhooks",
  "123456789012345678",
  "A".repeat(48),
].join("/");
assert.match(
  secretLikeReason(`webhook=${discordWebhook}`),
  /secret-bearing webhook URL/,
  "Discord webhook URLs are rejected",
);
const telegramBotToken = ["123456789", ":", "A".repeat(35)].join("");
const telegramWebhook = [
  "https://api.telegram.org",
  `bot${telegramBotToken}`,
].join("/");
assert.match(
  secretLikeReason(`webhook=${telegramWebhook}`),
  /secret-bearing webhook URL/,
  "Telegram bot-token URLs are rejected",
);
const genericTokenCredential = [
  "npm",
  "credential",
  "abcdefghijklmnopqrstuvwxyz",
].join("-");
assert.match(
  secretLikeReason(`TOKEN="${genericTokenCredential}"`),
  /literal (?:generic token|credential) assignment/,
  "quoted generic TOKEN assignments are rejected",
);
assert.match(
  secretLikeReason(`NPM_TOKEN: ${genericTokenCredential}`),
  /literal (?:generic token|credential) assignment/,
  "unquoted NPM_TOKEN assignments are rejected",
);
assert.match(
  secretLikeReason(`SERVICE_API_TOKEN=${genericTokenCredential}`),
  /literal generic token assignment/,
  "uppercase service token assignments are rejected",
);
assert.match(
  secretLikeReason(`service_token: "${genericTokenCredential}"`),
  /literal generic token assignment/,
  "lowercase service token assignments are rejected",
);
assert.match(
  secretLikeReason(`SERVICE_API_KEY=${genericTokenCredential}`),
  /literal credential assignment/,
  "prefixed API-key assignments are rejected",
);
assert.match(
  secretLikeReason(`service_client_secret: "${genericTokenCredential}"`),
  /literal credential assignment/,
  "prefixed client-secret assignments are rejected",
);
assert.match(
  secretLikeReason(`serviceApiKey: "${genericTokenCredential}"`),
  /literal credential assignment/,
  "camelCase API-key assignments are rejected",
);
assert.match(
  secretLikeReason(`stripeSecretKey: "${genericTokenCredential}"`),
  /literal credential assignment/,
  "camelCase secret-key assignments are rejected",
);
assert.match(
  secretLikeReason(`databasePassword: "${genericTokenCredential}"`),
  /literal credential assignment/,
  "camelCase password assignments are rejected",
);
assert.match(
  secretLikeReason(`export SERVICE_API_KEY=${genericTokenCredential}`),
  /literal credential assignment/,
  "exported unquoted credential assignments are rejected",
);
const modernNpmToken = ["npm", "_", "A".repeat(32)].join("");
assert.match(
  secretLikeReason(`registry credential: ${modernNpmToken}`),
  /credential-like token/,
  "modern npm tokens are rejected without relying on an assignment key",
);
assert.equal(
  secretLikeReason('TOKEN="${NPM_TOKEN}"'),
  null,
  "generic token placeholders remain allowed",
);
assert.equal(
  secretLikeReason("SERVICE_API_TOKEN=${SERVICE_API_TOKEN}"),
  null,
  "service token placeholders remain allowed",
);
// A shell parameter expansion carrying a default, assign, alternate, or error
// operator resolves at runtime the way a bare `${VAR}` does, so the diff carries
// no literal. Before this, a PR that merely moved a shell file containing one
// aborted the whole bundle, because the scanner read the expansion as a
// credential and scans removed lines too.
assert.equal(
  secretLikeReason('GH_API_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"'),
  null,
  "nested shell default expansions are references, not literal tokens",
);
assert.equal(
  secretLikeReason('SERVICE_TOKEN="${SERVICE_TOKEN-}"'),
  null,
  "unset-only shell default expansions are references",
);
assert.equal(
  secretLikeReason('API_TOKEN="${API_TOKEN:=${FALLBACK_TOKEN}}"'),
  null,
  "assign-default shell expansions are references",
);
assert.equal(
  secretLikeReason('API_TOKEN="${CI:+${GITHUB_TOKEN}}"'),
  null,
  "alternate shell expansions whose word is a reference are references",
);
assert.equal(
  secretLikeReason('API_KEY="${3:-${QUICKNODE_API_KEY-}}"'),
  null,
  "positional-parameter shell expansions are references",
);
assert.equal(
  secretLikeReason('SERVICE_TOKEN="${SERVICE_TOKEN:?}"'),
  null,
  "colon-error shell expansions are references",
);
assert.equal(
  secretLikeReason('SERVICE_TOKEN="${SERVICE_TOKEN?$FALLBACK_TOKEN}"'),
  null,
  "unset-error shell expansions whose word is a reference are references",
);
// Anti-bypass: the word after the operator is the one place a literal can hide,
// and the brace that closes the expansion has to end the value. Each fixture is
// joined from parts so this file's own source carries no credential-key
// assignment for the scanner to reject when the diff is reviewed.
const tokenAssignment = (value) =>
  ["GH_API_TOKEN", "=", '"', value, '"'].join("");
assert.match(
  secretLikeReason(
    tokenAssignment(["${GH_TOKEN:-", genericTokenCredential, "}"].join("")),
  ),
  /literal generic token assignment/,
  "a literal default inside a shell expansion is still rejected",
);
assert.match(
  secretLikeReason(
    tokenAssignment(["${GH_TOKEN:+", genericTokenCredential, "}"].join("")),
  ),
  /literal generic token assignment/,
  "a literal alternate inside a shell expansion is still rejected",
);
assert.match(
  secretLikeReason(
    tokenAssignment(["${GH_TOKEN:-}", genericTokenCredential].join("")),
  ),
  /literal generic token assignment/,
  "a literal fused to a shell expansion fails the ^…$ anchor and is rejected",
);
assert.match(
  secretLikeReason(
    tokenAssignment(
      ["${GH_TOKEN:-${A:-", genericTokenCredential, "}}"].join(""),
    ),
  ),
  /literal generic token assignment/,
  "a literal nested one level deeper in a default is still rejected",
);
// The word is measured against shell-native reference forms only. Under shell
// semantics a `secrets.…`/`var.…` word is a plain literal, so the broader
// placeholder grammar would otherwise carry a credential through a default.
for (const scope of ["secrets", "var", "local"]) {
  assert.match(
    secretLikeReason(
      tokenAssignment(
        ["${GH_TOKEN:-", scope, ".", genericTokenCredential, "}"].join(""),
      ),
    ),
    /literal generic token assignment/,
    `a ${scope}.* word inside a shell default is a literal, not a reference`,
  );
}
assert.equal(
  secretLikeReason('GH_API_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"'),
  null,
  "a bare $VAR word inside a shell default is a reference",
);
assert.match(
  secretLikeReason(
    tokenAssignment(["${GH_TOKEN:?", genericTokenCredential, "}"].join("")),
  ),
  /literal generic token assignment/,
  "a literal in a shell error-operator word is still rejected",
);
// An exactly-empty quoted default expands to the empty string, so it is inert.
// Anything inside those quotes is a literal and stays subject to the rules.
assert.equal(
  secretLikeReason(tokenAssignment("${GH_TOKEN:-''}")),
  null,
  "an exactly-empty quoted word inside a shell default is a reference",
);
assert.equal(
  secretLikeReason(["GH_API_TOKEN", "=", "'", '${GH_TOKEN:-""}', "'"].join("")),
  null,
  "the double-quoted empty word is likewise a reference",
);
assert.match(
  secretLikeReason(
    tokenAssignment(["${GH_TOKEN:-'", genericTokenCredential, "'}"].join("")),
  ),
  /literal credential (?:assignment|expression)/,
  "a quoted non-empty word inside a shell default is still rejected",
);
// Nesting is bounded: each level recurses and rescans its own substring, so an
// unbounded one costs quadratic time and a stack frame per level. Past the bound
// the value is not a reference, which leaves it subject to the literal rules —
// the fail-closed direction.
const nestedShellExpansion = (depth) =>
  "${A:-".repeat(depth) + "}".repeat(depth);
assert.equal(
  secretLikeReason(tokenAssignment(nestedShellExpansion(8))),
  null,
  "shell expansions nested to the bound are still references",
);
assert.match(
  secretLikeReason(tokenAssignment(nestedShellExpansion(9))),
  /literal generic token assignment/,
  "shell expansions nested past the bound are not references",
);
// The adversarial input the bound exists for: unbounded, 100,000 levels threw
// `RangeError: Maximum call stack size exceeded` out of the scanner and aborted
// bundle preparation instead of returning a verdict. Returning a verdict at all
// is the whole property; wall-clock is not asserted, because the fixture also
// runs every other rule in the scanner and a time budget would only measure the
// machine.
assert.match(
  secretLikeReason(tokenAssignment(nestedShellExpansion(100_000))),
  /literal generic token assignment/,
  "a deeply nested shell expansion returns a verdict instead of overflowing",
);
assert.equal(
  secretLikeReason("GH_TOKEN: ${{ github.token }}"),
  null,
  "GitHub Actions github.* context expressions are references, not literal tokens",
);
assert.equal(
  secretLikeReason("APP_TOKEN: ${{ steps.app-token.outputs.token }}"),
  null,
  "steps.*.outputs.* expressions are references, not literal tokens",
);
assert.equal(
  secretLikeReason("PROBE_TOKEN: ${{ needs.build.outputs.token }}"),
  null,
  "needs.*.outputs.* expressions are references, not literal tokens",
);
assert.match(
  secretLikeReason(
    `service_token: "\${{ github.token }}${genericTokenCredential}"`,
  ),
  /literal generic token assignment/,
  "a real literal trailing a github.* expression is still rejected (anchor holds)",
);
// Escaped shell expansions. Inside a JS template literal `\${VAR:-}` is a JS
// escape, so the emitted shell script receives `${VAR:-}` — a parameter
// expansion that yields the variable's value when set and non-null, and the
// (empty) default otherwise, always at run time; the committed source carries
// no literal credential either way. `placeholderValue` strips exactly one
// leading backslash and requires the remainder to be a whole reference on its
// own.
//
// Every value below uses a long variable name deliberately. A short one such
// as `\${V}` sits under CREDENTIAL_LITERAL_MIN_LENGTH and clears whether or
// not the clause exists, which would make the pin vacuous: each assertion here
// fails against a scanner without the clause.
const BACKSLASH = "\\";
const expansionVariable = "SENTRY_TRIAGE_TOKEN";
const escapedExpansion = (body) => tokenAssignment([BACKSLASH, body].join(""));
assert.equal(
  secretLikeReason(escapedExpansion(["${", expansionVariable, "}"].join(""))),
  null,
  "an escaped shell expansion is a reference, not a literal token",
);
for (const operator of [":-", "-", ":=", "=", ":+", "+", ":?", "?"]) {
  assert.equal(
    secretLikeReason(
      escapedExpansion(["${", expansionVariable, operator, "}"].join("")),
    ),
    null,
    `an escaped ${operator} expansion with an empty word is a reference`,
  );
  assert.equal(
    secretLikeReason(
      escapedExpansion(
        ["${", expansionVariable, operator, "$FALLBACK_TOKEN}"].join(""),
      ),
    ),
    null,
    `an escaped ${operator} expansion with a reference word is a reference`,
  );
}
assert.equal(
  secretLikeReason(escapedExpansion(nestedShellExpansion(8))),
  null,
  "escaped expansions nested to the bound are still references",
);
// The motivating line, copied from
// scripts/sentry/broker/sentry-mcp-broker.test.mjs:1036 (#1970 row 1).
const brokerShellToken = [
  "    ",
  "token",
  "=",
  '"',
  BACKSLASH,
  "${SENTRY_TRIAGE_TOKEN:-}",
  '"',
].join("");
assert.equal(
  secretLikeReason(brokerShellToken),
  null,
  "the broker suite's escaped shell expansion clears the scanner (#1970 row 1)",
);
// Exactly one backslash is stripped, and only the shell-expansion grammar is
// retried. Material attached to the reference, a second backslash, or another
// reference dialect all keep refusing.
assert.match(
  secretLikeReason(
    escapedExpansion(
      ["${", expansionVariable, ":-", genericTokenCredential, "}"].join(""),
    ),
  ),
  /literal generic token assignment/,
  "a literal default inside an escaped expansion is still rejected",
);
assert.match(
  secretLikeReason(
    escapedExpansion(
      ["${", expansionVariable, ":-$FALLBACK_TOKEN}", "suffix"].join(""),
    ),
  ),
  /literal generic token assignment/,
  "material fused after an escaped expansion fails the ^…$ anchor",
);
assert.match(
  secretLikeReason(
    tokenAssignment(
      ["junkjunkjunk", BACKSLASH, "${", expansionVariable, "}"].join(""),
    ),
  ),
  /literal generic token assignment/,
  "junk before an escaped expansion is rejected: the backslash has to lead",
);
assert.match(
  secretLikeReason(
    escapedExpansion([BACKSLASH, "${", expansionVariable, "}"].join("")),
  ),
  /literal generic token assignment/,
  "two leading backslashes are rejected: exactly one is stripped",
);
assert.match(
  secretLikeReason(
    escapedExpansion(["${{ secrets.", expansionVariable, " }}"].join("")),
  ),
  /literal generic token assignment/,
  "escaped GitHub Actions expressions stay refused: the retry is shell-only",
);
// An asymmetry worth stating: the unescaped `${var.x}` form clears through
// placeholderValue's HCL clause, but the escaped form does not, because the
// new clause retries `shellExpansionReference` alone and that grammar has no
// HCL clause. Refusing is the fail-closed direction and no fixture needs it.
assert.match(
  secretLikeReason(escapedExpansion("${var.sentry_triage_token}")),
  /literal generic token assignment/,
  "escaped HCL traversals refuse: the retried grammar is shell-only",
);
assert.equal(
  secretLikeReason(tokenAssignment("${var.sentry_triage_token}")),
  null,
  "the unescaped HCL traversal still clears, so the asymmetry is deliberate",
);
assert.match(
  secretLikeReason(escapedExpansion(nestedShellExpansion(9))),
  /literal generic token assignment/,
  "escaped expansions nested past the bound are not references",
);
// Only the outer backslash is stripped, so the inner `\${…}` is not a valid
// word and the whole value refuses. Fail-closed, and no real fixture needs it.
assert.match(
  secretLikeReason(
    escapedExpansion(
      ["${", expansionVariable, ":-", BACKSLASH, "${FALLBACK_TOKEN:-}}"].join(
        "",
      ),
    ),
  ),
  /literal generic token assignment/,
  "a nested escaped inner reference refuses: one backslash is stripped, not each",
);
// The other three #1970 rows are a different gap — a `%%` expansion the shell
// grammar does not accept, and hyphenated-word fixtures — and stay refused.
const shellOwnerTokenLine = [
  "const SHELL_OWNER_TOKEN = ",
  "`",
  "'",
  '"',
  BACKSLASH,
  "${REPO%%/*}",
  '"',
  "'",
  "`",
  ";",
].join("");
assert.match(
  secretLikeReason(shellOwnerTokenLine),
  /literal credential assignment/,
  "#1970 row 2 still refuses: `%%` is not a shell-expansion operator",
);
assert.match(
  secretLikeReason(
    [
      "      ",
      "AWS_SECRET_ACCESS_KEY",
      ": ",
      '"',
      "aws-secret-value",
      '",',
    ].join(""),
  ),
  /literal AWS credential assignment/,
  "#1970 row 3 still refuses: hyphenated-word fixtures are a separate gap",
);
assert.match(
  secretLikeReason(
    [
      "      ",
      "SENTRY_PROJECTION_TOKEN",
      ": ",
      '"',
      "projection-secret-value",
      '",',
    ].join(""),
  ),
  /literal generic token assignment/,
  "#1970 row 4 still refuses: hyphenated-word fixtures are a separate gap",
);
// Terraform/HCL traversal references (var/local/module/data) name a value
// resolved at plan/apply time, never an inline secret — the same reference
// class as the ${{ … }} contexts above. `var.*` was already recognized;
// local/module/data were not, so a credential-named attribute or local set from
// one tripped the scanner even though the diff carried no literal.
assert.equal(
  secretLikeReason("  audit_token = local.platform_settings_audit_token"),
  null,
  "HCL local.* references are placeholders, not literal tokens",
);
assert.equal(
  secretLikeReason("  client_secret = module.github_app.private_key"),
  null,
  "HCL module.*.output references are placeholders, not literal credentials",
);
assert.equal(
  secretLikeReason(
    "  api_key = data.terraform_remote_state.platform.outputs.audit_token",
  ),
  null,
  "HCL data.* references are placeholders, not literal credentials",
);
// The legacy `${…}` interpolation wrapper must recognize the same HCL scopes as
// the bare form, or `some_token = ${local.x}` would still trip the scanner.
assert.equal(
  secretLikeReason("some_token = ${local.audit_token}"),
  null,
  "legacy ${local.*} interpolation is a reference, not a literal token",
);
assert.match(
  secretLikeReason(`some_token = \${local.x}${genericTokenCredential}`),
  /literal generic token assignment/,
  "a real literal fused to a ${local.*} interpolation still flags (anchor holds)",
);
// Regression: a github_actions_secret block that mirrors a variable into a repo
// secret carries only references plus the secret's public NAME literal — never a
// committed secret value.
const githubActionsSecretBlock = [
  'resource "github_actions_secret" "platform_settings_audit_token" {',
  '  count       = var.platform_settings_audit_token == "" ? 0 : 1',
  '  repository  = "monitoring-monorepo"',
  '  secret_name = "PLATFORM_SETTINGS_AUDIT_TOKEN"',
  "  value       = var.platform_settings_audit_token",
  "}",
].join("\n");
assert.equal(
  secretLikeReason(githubActionsSecretBlock),
  null,
  "a github_actions_secret block of var references + a secret NAME literal is not a secret",
);
assert.equal(
  secretLikeReason(
    githubActionsSecretBlock.replace(
      "value       = var.platform_settings_audit_token",
      "value       = local.platform_settings_audit_token",
    ),
  ),
  null,
  "the same block mirroring a local.* reference is likewise reference-only",
);
// Anti-bypass: the reference clause is anchored, so a real literal in the same
// HCL `key = "…"` form — or one trailing an HCL reference — is still rejected.
assert.match(
  secretLikeReason(`  auth_token = "${genericTokenCredential}"`),
  /literal (?:generic token|credential) assignment/,
  'a real literal credential in HCL key = "…" form is still rejected',
);
assert.match(
  secretLikeReason(`  auth_token = local.x ${genericTokenCredential}`),
  /literal generic token assignment/,
  "a real literal trailing an HCL reference fails the ^…$ anchor and is rejected",
);
// HCL iteration traversals are the same reference class: `each`/`count` are the
// fixed for_each and count scopes, `self` is a resource's own attributes, and
// `rule` is the dynamic-block iterator this repo's alert rules declare. Both
// diff directions are asserted, because the scanner reads removed lines too and
// a PR that only deletes such a line lost its bundle as well.
for (const direction of ["+", "-"]) {
  assert.equal(
    secretLikeReason(`${direction}        token    = rule.value.token`),
    null,
    `dynamic-block iterator traversals are references (${direction} side)`,
  );
  assert.equal(
    secretLikeReason(`${direction}  client_secret = each.value.secret`),
    null,
    `for_each iterator traversals are references (${direction} side)`,
  );
}
assert.equal(
  secretLikeReason("  auth_token = self.triggers.auth_token"),
  null,
  "self.* provisioner traversals are references, not literal tokens",
);
// Anti-bypass: the traversal has to be the whole unquoted value. A quoted value
// is an HCL string, an unlisted scope is not a traversal, and a literal fused to
// or trailing one fails the ^…$ anchor.
const iterationTraversal = ["rule", "value", "token"].join(".");
assert.match(
  secretLikeReason(`  token = "${iterationTraversal}"`),
  /literal (?:generic token|credential) assignment/,
  "a quoted traversal-shaped value is an HCL string literal, not a reference",
);
assert.match(
  secretLikeReason(`  auth_token = each.value.token ${genericTokenCredential}`),
  /literal generic token assignment/,
  "a literal trailing an iteration traversal is still rejected",
);
assert.match(
  secretLikeReason(`  auth_token = iterator.value.${genericTokenCredential}`),
  /literal generic token assignment/,
  "an unlisted scope is not a traversal and stays subject to the literal rules",
);
// A TypeScript type annotation occupies type position and carries no value at
// all, so `token: string | undefined` names a shape the compiler erases. The
// generic pattern had no type-position awareness and read the annotation as a
// literal, so editing or moving an interface aborted the bundle.
for (const direction of ["+", "-"]) {
  assert.equal(
    secretLikeReason(`${direction}  token: string | undefined,`),
    null,
    `optional-token annotations are type positions (${direction} side)`,
  );
}
assert.equal(
  secretLikeReason("  refresh_token: number | undefined,"),
  null,
  "any union of built-in keywords is a type annotation",
);
assert.equal(
  secretLikeReason("  token: string[] | undefined,"),
  null,
  "array type members are type annotations",
);
assert.equal(
  secretLikeReason("  token: string | undefined;"),
  null,
  "semicolon-terminated interface members are type annotations",
);
// The scanner reads a whole diff and has no file type, so each rule carries its
// own syntactic discriminator. The annotation rule accepts a closed keyword
// vocabulary, which carries no credential in any language; the traversal rule
// reads the spaced `=`, which a shell assignment cannot take; the command-list
// rule reads `=` only.
assert.match(
  secretLikeReason("  token: Address | undefined,"),
  /literal generic token assignment/,
  "a named type is outside the keyword vocabulary and stays a literal",
);
assert.match(
  secretLikeReason("  token=each.value.audit_token"),
  /literal generic token assignment/,
  "an unspaced `=` is a shell assignment, so a traversal-shaped value is literal",
);
assert.match(
  secretLikeReason("  export SERVICE_TOKEN=each.value.audit_token"),
  /literal (?:generic token|credential) assignment/,
  "an exported shell assignment is likewise not an HCL attribute",
);
assert.match(
  secretLikeReason("  token: $(get_access_token) || return 1"),
  /literal generic token assignment/,
  "the command-list rule reads `=` values, not `key: value` scalars",
);
// Anti-bypass: every member has to be one of the built-in keywords, so no
// member can carry a credential and no credential can be split across members —
// the bypass a per-member length bound would leave open. Quoting the same text
// makes it a literal again.
assert.match(
  secretLikeReason(`  token: string | ${genericTokenCredential},`),
  /literal generic token assignment/,
  "a credential-sized union member is still rejected",
);
const splitCredential = ["abcdefghij", "klmnopqrst"].join(" | ");
assert.match(
  secretLikeReason(`  token: string | ${splitCredential},`),
  /literal generic token assignment/,
  "a literal split across short union members is still rejected",
);
const quotedAnnotation = ["string | ", genericTokenCredential].join("");
assert.match(
  secretLikeReason(`  token: "${quotedAnnotation}",`),
  /literal (?:generic token|credential) assignment/,
  "a quoted annotation-shaped value is a string literal, not a type",
);
assert.match(
  secretLikeReason("  token = string | undefined"),
  /literal generic token assignment/,
  "type position is `:` only; the HCL/shell `=` form stays subject to the rules",
);
// A shell command list continues past the assignment: the value is the command
// substitution, resolved when the script runs, and the operator's right side is
// a separate command. The line patterns have no shell grammar, so they captured
// the tail too and read the whole span as a literal.
for (const direction of ["+", "-"]) {
  assert.equal(
    secretLikeReason(
      `${direction}  access_token=$(get_access_token) || return 1`,
    ),
    null,
    `command substitutions with a control tail are references (${direction} side)`,
  );
}
assert.equal(
  secretLikeReason("  refresh_token=$(mint --scope repo) && log ok"),
  null,
  "an && control tail is likewise a separate command",
);
assert.equal(
  secretLikeReason("  access_token=$(get_access_token) || return 1 || exit 2"),
  null,
  "chained control operators are still a command list",
);
assert.equal(
  secretLikeReason(
    "  access_token=$(vault read -field=token secret/path) || return 1",
  ),
  null,
  "flags and paths are inert arguments: each part stays under credential length",
);
assert.match(
  secretLikeReason("  access_token=$(cat /run/secrets/api_token) || return 1"),
  /literal generic token assignment/,
  "the argument bound is uniform: even a real long path fails closed",
);
// Anti-bypass: the tail's alphabet excludes `=`, `:`, quotes, `$`, and
// parentheses, so a second assignment cannot hide in it, and its words are
// bounded whole rather than by segment, so a literal split across separators
// cannot either. A literal head, or anything between the head and the operator,
// is still a literal.
assert.match(
  secretLikeReason(
    `  access_token=$(get) || SERVICE_TOKEN=${genericTokenCredential}`,
  ),
  /literal generic token assignment/,
  "a credential assignment in the control tail is still rejected",
);
assert.match(
  secretLikeReason(
    `  access_token=$(get) || SERVICE_TOKEN="${genericTokenCredential}"`,
  ),
  /literal (?:generic token|credential) (?:assignment|expression)/,
  "a quoted credential assignment in the control tail is still rejected",
);
assert.match(
  secretLikeReason(`  access_token=${genericTokenCredential} || return 1`),
  /literal generic token assignment/,
  "a literal head with a control tail is still rejected",
);
assert.match(
  secretLikeReason(
    `  access_token=$(get) ${genericTokenCredential} || return 1`,
  ),
  /literal generic token assignment/,
  "a literal between the substitution and the operator is still rejected",
);
assert.match(
  secretLikeReason(`  access_token=$(echo ${modernNpmToken}) || return 1`),
  /credential-like token/,
  "a strong credential inside the substitution is still rejected",
);
assert.match(
  secretLikeReason(`  access_token=$(get) || echo ${genericTokenCredential}`),
  /literal generic token assignment/,
  "a credential-sized tail word is still rejected, assignment or not",
);
// The substitution's arguments are bounded too. A weak literal in argument
// position carries no strong pattern, so nothing else in the scanner would
// catch it, and a long one split across separators is measured whole.
const separatorSplitCredential = ["correct", "horse", "battery", "staple"].join(
  "-",
);
assert.match(
  secretLikeReason(
    `  access_token=$(echo ${separatorSplitCredential}) || return 1`,
  ),
  /literal generic token assignment/,
  "a separator-split literal argument is rejected",
);
assert.match(
  secretLikeReason(
    `  access_token=$(auth --${separatorSplitCredential}) || return 1`,
  ),
  /literal generic token assignment/,
  "a flag prefix does not exempt a literal from the argument bound",
);
assert.match(
  secretLikeReason(
    `  access_token=$(get) || SERVICE_TOKEN=${separatorSplitCredential}`,
  ),
  /literal generic token assignment/,
  "a separator-split literal in the control tail is rejected",
);
assert.match(
  secretLikeReason(
    `  access_token=$(echo ${genericTokenCredential}) || return 1`,
  ),
  /literal generic token assignment/,
  "a weak literal argument inside the substitution is rejected",
);
assert.match(
  secretLikeReason(
    `  access_token=$(auth --token ${genericTokenCredential}) || return 1`,
  ),
  /literal generic token assignment/,
  "a weak literal behind a flag is rejected",
);
assert.match(
  secretLikeReason(
    `  access_token=$(auth --token=${genericTokenCredential}) || return 1`,
  ),
  /literal generic token assignment/,
  "a weak literal in a flag value is rejected",
);
assert.match(
  secretLikeReason(
    `  access_token=$(auth --${genericTokenCredential}) || return 1`,
  ),
  /literal generic token assignment/,
  "a weak literal wearing a flag prefix is rejected",
);
assert.match(
  secretLikeReason("  token = getToken() || fallback"),
  /literal generic token assignment/,
  "the head has to be a command substitution, not any call expression",
);
// Words are split on whitespace, so a nested substitution arrives as fragments
// carrying parentheses — outside the argument alphabet, and refused. This pins
// the property rather than the parse: no rearrangement of `$( … )` inside the
// substitution may reach the accept path.
assert.match(
  secretLikeReason(
    `  access_token=$(echo $(printf ${genericTokenCredential})) || return 1`,
  ),
  /literal generic token assignment/,
  "a literal inside a nested substitution is rejected",
);
// The command word is measured too: a real command name is short segments
// joined by separators, an opaque run is not.
assert.match(
  secretLikeReason(`  access_token=$(${"a".repeat(32)}) || return 1`),
  /literal generic token assignment/,
  "an opaque run in command position is not a command name",
);
// Refused by design: a fixture literal such as
// `ACTIONS_ID_TOKEN_REQUEST_TOKEN: "<hyphen-joined words>"` is a quoted literal
// in value position, and no syntax distinguishes it from a real weak
// credential — only the surrounding file says it is a fixture, and the diff
// author picks that file's name. Fixtures compose the literal from parts, the
// way this file does, or use a documented placeholder marker. This assertion
// exists so a later rule cannot start accepting the shape unnoticed.
const fixtureMarkerCredential = ["runner", "bound", "credential"].join("-");
assert.match(
  secretLikeReason(
    `    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "${fixtureMarkerCredential}",`,
  ),
  /literal generic token assignment/,
  "a hyphen-joined fixture literal is still refused; compose it from parts",
);
assert.equal(
  secretLikeReason('    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-token",'),
  null,
  "the documented placeholder markers remain the fixture workaround",
);
const publicEvmTokenAddress = ["0x", "0".repeat(39), "1"].join("");
assert.match(
  secretLikeReason(`USDC_TOKEN="${publicEvmTokenAddress}"`),
  /literal generic token assignment/,
  "prefixed token keys do not receive the narrow public-address exemption",
);
assert.equal(
  secretLikeReason('"token": "0x0000000000000000000000000000000000000001",'),
  null,
  "JSON public token-address fields are allowed",
);
assert.equal(
  secretLikeReason("token: 0x0000000000000000000000000000000000000001"),
  null,
  "unquoted public token-address fields are allowed",
);
assert.equal(
  secretLikeReason("token: 0x0000000000000000000000000000000000000001,"),
  null,
  "unquoted public token-address fields exclude trailing delimiters",
);
const opaqueHexToken = ["0x", "A".repeat(64)].join("");
assert.match(
  secretLikeReason(`SESSION_TOKEN=${opaqueHexToken}`),
  /literal generic token assignment/,
  "opaque 256-bit token values are not exempted as public addresses",
);
assert.match(
  secretLikeReason("SESSION_TOKEN=0x0000000000000000000000000000000000000001"),
  /literal generic token assignment/,
  "credential-semantic token keys do not receive the public-address exemption",
);
assert.match(
  secretLikeReason(`oauthToken=0x${"A".repeat(40)}`),
  /literal credential assignment/,
  "camelCase OAuth token keys do not receive the public-address exemption",
);
assert.match(
  secretLikeReason(`privateToken=0x${"A".repeat(40)}`),
  /literal credential assignment/,
  "camelCase private-token keys do not receive the public-address exemption",
);
assert.match(
  secretLikeReason(`export serviceApiKey=acct:${"A".repeat(20)}`),
  /literal credential assignment/,
  "punctuated exported credential values are rejected",
);
assert.equal(
  secretLikeReason("serviceApiKey: getServiceApiKey(),"),
  null,
  "function-call expressions are not treated as unquoted credential literals",
);
assert.equal(
  secretLikeReason("serviceApiKey: credentials.serviceApiKey"),
  null,
  "object-property member expressions are not treated as credential literals",
);
assert.equal(
  secretLikeReason("SERVICE_API_KEY=getServiceApiKey()"),
  null,
  "function-call expressions remain safe in equals assignments",
);
assert.match(
  secretLikeReason("SERVICE_API_KEY=production.secret.credential"),
  /literal credential assignment/,
  "dotted configuration credentials are not mistaken for member expressions",
);
assert.equal(
  secretLikeReason("token: resolveToken(address),"),
  null,
  "token resolver expressions are not treated as credential literals",
);
assert.equal(
  secretLikeReason("token: resolvedTokenValue,"),
  null,
  "comma-terminated identifier expressions are not credential literals",
);
assert.equal(
  secretLikeReason("token: config.accessToken,"),
  null,
  "comma-terminated member expressions are not credential literals",
);
assert.equal(
  secretLikeReason("serviceApiKey: credentials.serviceApiKey"),
  null,
  "final member expressions are not credential literals",
);
for (const identifier of ["resolved_token_value", "RESOLVED_TOKEN_VALUE"]) {
  assert.equal(
    secretLikeReason(`token: ${identifier},`),
    null,
    `comma-terminated identifier is not a credential literal: ${identifier}`,
  );
}
assert.equal(
  secretLikeReason("token: (resolvedTokenValue),"),
  null,
  "grouped identifier expressions are not credential literals",
);
const punctuatedTokenCredential = ["prod-secret", "(", "2026", ")"].join("");
assert.match(
  secretLikeReason(`token: ${punctuatedTokenCredential}`),
  /literal generic token assignment/,
  "punctuated token literals are not mistaken for function calls",
);
const wrappedTokenCredential = ["prod", "secret", "value", "123456"].join("-");
for (const [opening, closing] of [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]) {
  assert.match(
    secretLikeReason(`token: ${opening}"${wrappedTokenCredential}"${closing},`),
    /literal credential expression/,
    `${opening}${closing}-wrapped token literals are rejected`,
  );
}
for (const comment of ["// note", "/* note */"]) {
  assert.match(
    secretLikeReason(`token: ("${wrappedTokenCredential}"), ${comment}`),
    /literal credential expression/,
    `wrapped token literals remain rejected before ${comment} comments`,
  );
}
assert.equal(
  secretLikeReason('token: ("${TOKEN}"),'),
  null,
  "wrapped environment placeholders remain safe evidence",
);
assert.equal(
  secretLikeReason('token: resolveToken("address"),'),
  null,
  "function calls with quoted arguments remain code expressions",
);
assert.equal(
  secretLikeReason("token: (`Bearer ${resolvedTokenValue}`),"),
  null,
  "interpolated template expressions are not literal credentials",
);
assert.equal(
  secretLikeReason("const fixture = `token=${secret}`;"),
  null,
  "assignment-like text inside a template is not parsed as a code expression",
);
const staticTemplateCredential = ["opaque", "live", "abcdefghijklmnop"].join(
  "-",
);
assert.match(
  secretLikeReason(
    ["apiKey: String(`", staticTemplateCredential, "-${suffix}`),"].join(""),
  ),
  /literal credential expression/,
  "long static template chunks are rejected",
);
assert.match(
  secretLikeReason(
    ['apiKey: String(`${"', wrappedTokenCredential, '"}`),'].join(""),
  ),
  /literal credential expression/,
  "quoted credentials nested in template expressions are rejected",
);
const apiKeyAssignmentPrefix = ["api", "Key", ": "].join("");
assert.match(
  secretLikeReason(
    [
      apiKeyAssignmentPrefix,
      "`",
      "prod-secret-\n",
      "credential-123456",
      "`",
    ].join(""),
  ),
  /literal credential assignment/,
  "multiline direct template credentials are rejected",
);
assert.match(
  secretLikeReason(
    [apiKeyAssignmentPrefix, "`${`", wrappedTokenCredential, "`}`"].join(""),
  ),
  /literal credential expression/,
  "credentials in nested templates are rejected",
);
assert.equal(
  secretLikeReason("apiKey: `${process.env.API_KEY}`"),
  null,
  "full process.env interpolations remain safe evidence",
);
assert.equal(
  secretLikeReason('token: ("prefix-" + "suffix"),'),
  null,
  "concatenated short string expressions are not literal credentials",
);
const staticCredentialExpression = [
  "apiKey: ",
  '"prod-"',
  " + ",
  '"secret-"',
  " + ",
  '"1234567890"',
].join("");
assert.match(
  secretLikeReason(staticCredentialExpression),
  /literal credential expression/,
  "static credential concatenations are rejected after folding",
);
for (const joiner of [" +\n ", " + /* join */ "]) {
  assert.match(
    secretLikeReason(
      ["apiKey: ", '"prod-sec"', joiner, '"ret-123456"'].join(""),
    ),
    /literal credential expression/,
    `static credentials remain folded across ${JSON.stringify(joiner)}`,
  );
}
const addedDiffCredentialExpression = [
  "+api",
  'Key: "prod-se" +\n',
  '+  "cret-123456"',
].join("");
assert.match(
  secretLikeReason(addedDiffCredentialExpression),
  /literal credential expression/,
  "static credentials are folded across unified-diff line prefixes",
);
assert.equal(
  secretLikeReason('apiKey: "example-" + "api-" + "token"'),
  null,
  "folded example concatenations remain safe evidence",
);
assert.match(
  secretLikeReason(`apiKey: String("${wrappedTokenCredential}"),`),
  /literal credential expression/,
  "credential-valued function arguments are rejected",
);
const opaqueAuthorizationCredential = [
  "opaque",
  "live",
  "abcdefghijklmnop",
].join("_");
const authorizationAssignmentPrefix = ["Author", "ization", ": "].join("");
assert.match(
  secretLikeReason(`Authorization: "Bearer ${opaqueAuthorizationCredential}"`),
  /literal Authorization credential/,
  "opaque Bearer credentials are rejected",
);
assert.match(
  secretLikeReason(
    [
      "const req = { headers: { Author",
      'ization: "Bearer ',
      opaqueAuthorizationCredential,
      '" } };',
    ].join(""),
  ),
  /literal Authorization credential/,
  "Authorization credentials nested in object literals are rejected",
);
assert.match(
  secretLikeReason(
    [
      'headers["Author',
      'ization"] = "Bearer ',
      opaqueAuthorizationCredential,
      '"',
    ].join(""),
  ),
  /literal Authorization credential/,
  "Authorization credentials in computed properties are rejected",
);
const basicAuthorizationCredential = ["dXNl", "cjpw", "YXNz", "MTIz"].join("");
assert.match(
  secretLikeReason(`Authorization: "Basic ${basicAuthorizationCredential}"`),
  /literal Authorization credential/,
  "Basic credentials are rejected",
);
assert.match(
  secretLikeReason(
    `Authorization: String("Bearer ${opaqueAuthorizationCredential}"),`,
  ),
  /literal Authorization credential/,
  "credential-valued Authorization calls are rejected",
);
assert.match(
  secretLikeReason(
    [
      authorizationAssignmentPrefix,
      "`${`Bearer ",
      opaqueAuthorizationCredential,
      "`}`",
    ].join(""),
  ),
  /literal Authorization credential/,
  "Authorization credentials in nested templates are rejected",
);
assert.match(
  secretLikeReason(
    [
      authorizationAssignmentPrefix,
      "`Bearer ${`${",
      '"opaque_"',
      "}credential`}`",
    ].join(""),
  ),
  /literal Authorization credential/,
  "fully static nested Authorization templates are folded before scanning",
);
assert.equal(
  secretLikeReason(
    [
      apiKeyAssignmentPrefix,
      "`${`${",
      '"example"',
      "}`}-${`${",
      '"token"',
      "}`}`",
    ].join(""),
  ),
  null,
  "fully static nested example templates remain safe evidence",
);
assert.match(
  secretLikeReason(
    `Authorization: ("Bearer ${opaqueAuthorizationCredential}"),`,
  ),
  /literal Authorization credential/,
  "grouped Authorization literals are rejected",
);
assert.match(
  secretLikeReason(
    `Authorization: "Bearer ${opaqueAuthorizationCredential}" /*\nrotated\n*/`,
  ),
  /literal Authorization credential/,
  "Authorization literals remain rejected before multiline comments",
);
assert.equal(
  secretLikeReason('Authorization: "Bearer ${AUTH_TOKEN}"'),
  null,
  "Authorization credential placeholders remain safe evidence",
);
assert.equal(
  secretLikeReason('Authorization: String("Bearer ${AUTH_TOKEN}"),'),
  null,
  "Authorization call placeholders remain safe evidence",
);
assert.equal(
  secretLikeReason("Authorization: `Bearer ${process.env.AUTH_TOKEN}`"),
  null,
  "Authorization process.env interpolations remain safe evidence",
);
assert.equal(
  secretLikeReason("Authorization: process.env.AUTHORIZATION"),
  null,
  "Authorization header placeholders remain safe evidence",
);
for (const authorizationExpression of [
  "Authorization: config.authorization,",
  "Authorization: getAuthorization(),",
]) {
  assert.equal(
    secretLikeReason(authorizationExpression),
    null,
    `Authorization code expression is safe: ${authorizationExpression}`,
  );
}
assert.match(
  secretLikeReason(
    [authorizationAssignmentPrefix, opaqueAuthorizationCredential].join(""),
  ),
  /literal Authorization credential/,
  "unquoted opaque Authorization credentials remain rejected",
);
const bracketedEnvironmentReference = [
  "process.env",
  '["SERVICE_',
  'API_KEY"]',
].join("");
const bracketedAuthorizationReference = [
  "process.env",
  '["AUTHORIZ',
  'ATION"]',
].join("");
const bracketedAwsReference = [
  "process.env",
  '["AWS_SECRET_',
  'ACCESS_KEY"]',
].join("");
const bracketedAwsAssignmentPrefix = ["aws_secret", "_access_key", " = "].join(
  "",
);
const optionalEnvironmentReferences = [
  ["process", "?.env", '["SERVICE_', 'API_KEY"]'].join(""),
  ["process.env", "?.", '["SERVICE_', 'API_KEY"]'].join(""),
  ["process", "?.env?.", '["SERVICE_', 'API_KEY"]'].join(""),
];
for (const placeholderAssignment of [
  [apiKeyAssignmentPrefix, bracketedEnvironmentReference].join(""),
  [apiKeyAssignmentPrefix, "(", bracketedEnvironmentReference, "),"].join(""),
  [apiKeyAssignmentPrefix, "`${", bracketedEnvironmentReference, "}`"].join(""),
  [apiKeyAssignmentPrefix, "String(", bracketedEnvironmentReference, ")"].join(
    "",
  ),
  [authorizationAssignmentPrefix, bracketedAuthorizationReference].join(""),
  [bracketedAwsAssignmentPrefix, bracketedAwsReference].join(""),
  ...optionalEnvironmentReferences.map((reference) =>
    [apiKeyAssignmentPrefix, reference].join(""),
  ),
]) {
  assert.equal(
    secretLikeReason(placeholderAssignment),
    null,
    `bracketed environment placeholder is safe: ${placeholderAssignment}`,
  );
}
assert.equal(
  secretLikeReason("apiKey: process.env.API_KEY // safe comment"),
  null,
  "bounded line comments that reach EOF preserve the safe expression",
);
const nestedExpressionFallback = [
  "const config = {\n  ",
  apiKeyAssignmentPrefix,
  "\n    ",
  bracketedEnvironmentReference,
  '\n    ?? "',
  wrappedTokenCredential,
  '",\n};',
].join("");
assert.match(
  secretLikeReason(nestedExpressionFallback),
  /literal credential expression/,
  "nested expression-first credential fallbacks are rejected",
);
assert.match(
  secretLikeReason(
    [
      "const config = {\n  ",
      apiKeyAssignmentPrefix,
      bracketedEnvironmentReference,
      ' ?? // fallback\n    "',
      wrappedTokenCredential,
      '",\n};',
    ].join(""),
  ),
  /literal credential expression/,
  "expression-first fallbacks remain bounded across line comments",
);
const computedEnvironmentAssignment = [
  'config["service',
  'ApiKey"] = ',
  bracketedEnvironmentReference,
].join("");
assert.equal(
  secretLikeReason(computedEnvironmentAssignment),
  null,
  "computed credential properties may use bracketed environment placeholders",
);
assert.match(
  secretLikeReason(
    [computedEnvironmentAssignment, ' ?? "', wrappedTokenCredential, '"'].join(
      "",
    ),
  ),
  /literal credential expression/,
  "computed expression-first credential fallbacks are rejected",
);
const embeddedExpressionFallback = [
  "const fixture = ",
  String.fromCharCode(34),
  apiKeyAssignmentPrefix,
  "process.env.API_KEY ?? ",
  String.fromCharCode(39),
  wrappedTokenCredential,
  String.fromCharCode(39),
  String.fromCharCode(34),
  ";",
].join("");
assert.match(
  secretLikeReason(embeddedExpressionFallback),
  /literal credential expression/,
  "expression fallbacks embedded in quoted fixtures are rejected",
);
const oversizedCredentialExpression = [
  "const config = { ",
  apiKeyAssignmentPrefix,
  "(",
  "identifier + ".repeat(7000),
  'fallback ?? "',
  wrappedTokenCredential,
  '") };',
].join("");
assert.match(
  secretLikeReason(oversizedCredentialExpression),
  /credential assignment exceeds scan bound/,
  "oversized credential expressions fail closed before truncation",
);
for (const [openingComment, closingComment] of [
  ["//", "\n"],
  ["/*", "*/"],
]) {
  const oversizedCommentExpression = [
    apiKeyAssignmentPrefix,
    "process.env.API_KEY ?? ",
    openingComment,
    "x".repeat(65536),
    closingComment,
    '"',
    wrappedTokenCredential,
    '"',
  ].join("");
  assert.match(
    secretLikeReason(oversizedCommentExpression),
    /credential assignment exceeds scan bound/,
    `credential expressions with oversized ${openingComment} comments fail closed`,
  );
}
const commentedAwsSecretAccessKey = [
  "live",
  "aws",
  "credential",
  "123456",
].join("-");
const awsSecretAssignmentPrefix = ["aws_secret", "_access_key", " = "].join("");
assert.match(
  secretLikeReason(
    [
      "const config = { aws_secret",
      '_access_key: "',
      commentedAwsSecretAccessKey,
      '" };',
    ].join(""),
  ),
  /literal AWS credential assignment/,
  "AWS credentials nested in object literals are rejected",
);
assert.match(
  secretLikeReason(
    [
      'config["aws_secret',
      '_access_key"] = "',
      commentedAwsSecretAccessKey,
      '"',
    ].join(""),
  ),
  /literal AWS credential assignment/,
  "AWS credentials in computed properties are rejected",
);
assert.match(
  secretLikeReason(
    ['config["service', 'ApiKey"] = "', wrappedTokenCredential, '"'].join(""),
  ),
  /literal credential assignment/,
  "generic credentials in computed properties are rejected",
);
for (const comment of ["// rotated", "/* rotated */"]) {
  assert.match(
    secretLikeReason(
      `aws_secret_access_key = "${commentedAwsSecretAccessKey}" ${comment}`,
    ),
    /literal AWS credential assignment/,
    `AWS credentials remain rejected before ${comment} comments`,
  );
}
assert.match(
  secretLikeReason(
    [
      awsSecretAssignmentPrefix,
      "`${`",
      commentedAwsSecretAccessKey,
      "`}`",
    ].join(""),
  ),
  /literal AWS credential assignment/,
  "AWS credentials in nested templates are rejected",
);
for (const comment of ["//note", "/*note*/"]) {
  assert.match(
    secretLikeReason(`token: ("${wrappedTokenCredential}"),${comment}`),
    /literal credential expression/,
    `wrapped token literals survive zero-space ${comment} comments`,
  );
  assert.match(
    secretLikeReason(
      `Authorization: "Bearer ${opaqueAuthorizationCredential}",${comment}`,
    ),
    /literal Authorization credential/,
    `Authorization literals survive zero-space ${comment} comments`,
  );
  assert.match(
    secretLikeReason(
      `aws_secret_access_key = "${commentedAwsSecretAccessKey}"${comment}`,
    ),
    /literal AWS credential assignment/,
    `AWS credentials survive zero-space ${comment} comments`,
  );
}
assert.match(
  secretLikeReason("token: https://example.invalid/token-value"),
  /literal generic token assignment/,
  "URL slashes are not mistaken for zero-space comments",
);
const queryCredential = ["live", "query", "credential", "123456"].join("-");
const queryEndpoint = ["https://example.invalid/api", "?"].join("");
assert.match(
  secretLikeReason(`endpoint=${queryEndpoint}token=${queryCredential}`),
  /secret-bearing URL/,
  "literal token query parameters are rejected",
);
assert.equal(
  secretLikeReason(`endpoint=${queryEndpoint}token=\${SERVICE_API_TOKEN}`),
  null,
  "query-parameter environment placeholders are safe evidence",
);
const signedUrlSignature = ["signed", "url", "A".repeat(32)].join("-");
const signedObjectEndpoint = ["https://example.invalid/object", "?"].join("");
for (const parameterName of ["X-Amz-Signature", "X-Goog-Signature"]) {
  assert.match(
    secretLikeReason(
      `endpoint=${signedObjectEndpoint}${parameterName}=${signedUrlSignature}`,
    ),
    /secret-bearing URL/,
    `${parameterName} query parameters are rejected`,
  );
}
assert.match(
  secretLikeReason(
    `endpoint=${signedObjectEndpoint}token=${queryCredential}&sig=\${SIGNATURE}`,
  ),
  /secret-bearing URL/,
  "every sensitive query parameter is inspected before placeholder exemptions",
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

const root = realpathSync(
  mkdtempSync(path.join(tmpdir(), "agent-autoreview-core-test.")),
);
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
  () => readBoundedRegularFile(path.join(repo, "linked.md"), "linked fixture"),
  /regular file/,
  "bounded file reads reject symlink final components",
);
const outsideHardLinkSource = path.join(root, "outside-hard-link-source.md");
writeFileSync(outsideHardLinkSource, "outside evidence\n");
linkSync(outsideHardLinkSource, path.join(repo, "hard-linked.md"));
assert.throws(
  () => serializeSafeUntrackedFile(repo, "hard-linked.md"),
  /refusing hard-linked untracked file/,
  "untracked-file capture rejects hard links to files outside the checkout",
);
assert.throws(
  () =>
    readSafeEvidenceFile({
      repo,
      rawPath: "linked.md",
      label: "--prompt-file",
    }),
  /symlinked/,
);

const swappedRoot = path.join(root, "swapped-root");
const swappedDirectory = path.join(swappedRoot, "nested");
const swappedOutside = path.join(root, "swapped-outside");
mkdirSync(swappedRoot);
mkdirSync(swappedDirectory);
mkdirSync(swappedOutside);
const swappedCandidate = path.join(swappedDirectory, "evidence.md");
writeFileSync(swappedCandidate, "original evidence\n");
writeFileSync(path.join(swappedOutside, "evidence.md"), "outside evidence\n");
const swappedRootStat = lstatSync(swappedRoot);
const swappedFileStat = lstatSync(swappedCandidate);
renameSync(swappedDirectory, path.join(swappedRoot, "nested-original"));
symlinkSync(swappedOutside, swappedDirectory, "dir");
assert.throws(
  () =>
    assertStableEvidencePathAfterRead({
      root: swappedRoot,
      candidate: swappedCandidate,
      rootStat: swappedRootStat,
      fileStat: swappedFileStat,
      label: "swapped evidence",
    }),
  /escapes its allowed root after opening/,
  "post-open validation rejects an intermediate-directory swap outside the root",
);

const replacedCandidate = path.join(repo, "replaced.md");
writeFileSync(replacedCandidate, "original evidence\n");
const repoStatBeforeReplacement = lstatSync(repo);
const replacedFileStat = lstatSync(replacedCandidate);
renameSync(replacedCandidate, path.join(repo, "replaced-original.md"));
writeFileSync(replacedCandidate, "replacement evidence\n");
assert.throws(
  () =>
    assertStableEvidencePathAfterRead({
      root: repo,
      candidate: replacedCandidate,
      rootStat: repoStatBeforeReplacement,
      fileStat: replacedFileStat,
      label: "replaced evidence",
    }),
  /changed while it was being read/,
  "post-open validation rejects a path whose inode changed",
);

const postReadHardLinkCandidate = path.join(repo, "post-read-hard-link.md");
const postReadHardLinkAlias = path.join(root, "post-read-hard-link-alias.md");
writeFileSync(postReadHardLinkCandidate, "original evidence\n");
const repoStatBeforeHardLink = lstatSync(repo);
const postReadHardLinkStat = lstatSync(postReadHardLinkCandidate);
linkSync(postReadHardLinkCandidate, postReadHardLinkAlias);
assert.throws(
  () =>
    assertStableEvidencePathAfterRead({
      root: repo,
      candidate: postReadHardLinkCandidate,
      rootStat: repoStatBeforeHardLink,
      fileStat: postReadHardLinkStat,
      label: "post-read hard-linked evidence",
    }),
  /changed while it was being read/,
  "post-open validation rejects a file that gained another hard link",
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
assert.throws(
  () => writeReviewPromptOutputs(promptIndex, ["new pass one", "new pass two"]),
  /refusing to replace an existing multi-pass review prompt set/,
  "multi-pass publication never mutates an already valid prompt set",
);
assert.equal(readFileSync(outputs[1], "utf8"), "pass one");
assert.equal(readFileSync(outputs[2], "utf8"), "pass two");
assert.deepEqual(reviewPromptOutputPaths("/published/review.md", 2), [
  "/published/review.md",
  "/published/review.pass-01-of-02.md",
  "/published/review.pass-02-of-02.md",
]);

const singleOutput = path.join(root, "single-output.md");
writeReviewPromptOutputs(singleOutput, ["original single output"]);
assert.throws(
  () => writeReviewPromptOutputs(singleOutput, ["replacement output"]),
  /refusing to replace an existing review prompt output/,
  "single-pass publication never clobbers an existing destination",
);
assert.equal(
  readFileSync(singleOutput, "utf8"),
  "original single output",
  "failed single-pass replacement preserves the published output",
);

const outputVictim = path.join(root, "output-victim.md");
const linkedOutput = path.join(root, "linked-output.md");
writeFileSync(outputVictim, "do not overwrite\n");
symlinkSync(outputVictim, linkedOutput);
assert.throws(
  () => writeReviewPromptOutputs(linkedOutput, ["unsafe output"]),
  /refusing unsafe review prompt output path/,
  "prompt publication refuses a symlink destination",
);
assert.equal(readFileSync(outputVictim, "utf8"), "do not overwrite\n");

const realOutputDirectory = path.join(root, "real-output");
const linkedOutputDirectory = path.join(root, "linked-output-directory");
mkdirSync(realOutputDirectory);
symlinkSync(realOutputDirectory, linkedOutputDirectory, "dir");
writeReviewPromptOutputs(path.join(linkedOutputDirectory, "review.md"), [
  "canonical parent output",
]);
assert.equal(
  readFileSync(path.join(realOutputDirectory, "review.md"), "utf8"),
  "canonical parent output",
  "prompt publication canonicalizes a stable parent before writing",
);

rmSync(root, { recursive: true, force: true });
console.log("agent-autoreview core tests passed");
