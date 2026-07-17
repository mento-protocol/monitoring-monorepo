#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chmodSync,
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

const stableReadStat = {
  dev: 1,
  ino: 2,
  mode: 0o100644,
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
