#!/usr/bin/env node
/**
 * Fixture-driven tests for scripts/sanitize-terraform-output.sh.
 *
 * Runs the real script (via child_process) against a fixture file that
 * plants one fake secret per redaction class (the `sed -E` -e patterns),
 * including raw and backslash-escaped-quote variants as they appear in
 * terraform JSON plan diffs, plus near-miss strings that must survive
 * byte-identical. Asserts every planted secret becomes `[REDACTED]` and
 * every near-miss is untouched.
 *
 * Run: node scripts/sanitize-terraform-output.test.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(repoRoot, "scripts/sanitize-terraform-output.sh");

// ── helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
    passed++;
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  \x1b[31m✖\x1b[0m ${name}`);
    console.error(`    ${msg}`);
    failed++;
  }
}

/**
 * @param {boolean} condition
 * @param {string} msg
 */
function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function assertIncludes(haystack, needle, msg) {
  assert(haystack.includes(needle), `${msg}\nexpected to find: ${needle}`);
}

function assertNotIncludes(haystack, needle, msg) {
  assert(
    !haystack.includes(needle),
    `${msg}\nexpected NOT to find (secret leaked): ${needle}`,
  );
}

// ── fixture ───────────────────────────────────────────────────────────────────
// One planted fake secret per redaction class, plus escaped-quote JSON
// variants and near-miss strings that must survive unredacted.

const FIXTURE_LINES = [
  // Discord webhook URLs: discord.com / discordapp.com, with / without /v10.
  'webhook_url_a = "https://discord.com/api/webhooks/123456789012345678/SECRETDISCORDTOKENAAAA"',
  'webhook_url_b = "https://discord.com/api/v10/webhooks/123456789012345678/SECRETDISCORDTOKENBBBB"',
  'webhook_url_c = "https://discordapp.com/api/webhooks/123456789012345678/SECRETDISCORDTOKENCCCC"',
  'webhook_url_d = "https://discordapp.com/api/v10/webhooks/123456789012345678/SECRETDISCORDTOKENDDDD"',
  // VictorOps / Splunk URLs.
  'victorops_url = "https://alert.victorops.com/integrations/generic/20131114/alert/SECRETVICTOROPSTOKEN/routing_key"',
  'splunk_url = "https://splunk.example.com:8088/services/collector/event?token=SECRETSPLUNKTOKEN1234"',
  // JSON "token": "..." — plain and backslash-escaped-quote (terraform JSON diff) variants.
  '"token": "SECRETJSONTOKENPLAIN1234567890"',
  '\\"token\\": \\"SECRETJSONTOKENESCAPED1234567890\\"',
  // HCL token = "...".
  'token = "SECRETHCLTOKENVALUE1234567890"',
  // Bare (unquoted) api_key, both ":" and "=" forms.
  "api_key: SECRETBAREAPIKEYCOLON1234567890",
  "api_key = SECRETBAREAPIKEYEQUALS1234567890",
  // JSON-quoted *api_key, both ":" and "=" forms, plain and escaped-quote.
  '"webhook_api_key": "SECRETJSONAPIKEYCOLON1234567890"',
  '\\"webhook_api_key\\": \\"SECRETJSONAPIKEYCOLONESCAPED1234567890\\"',
  '"webhook_api_key" = "SECRETJSONAPIKEYEQUALS1234567890"',
  // HCL *_key = "...".
  'splunk_key = "SECRETHCLUNDERSCOREKEYVALUE1234567890"',
  // security_token: bare colon form, and JSON-quoted (plain + escaped) form.
  "security_token: SECRETSECURITYTOKENVALUE1234567890",
  // Bare equals (unquoted) form — regression guard against the "[:=]" branch
  // silently narrowing to "[:]" and dropping this form's redaction.
  "security_token = SECRETSECURITYTOKENBAREEQUALS1234567890",
  // Bare colon form with a base64-ish value (/, +, = characters), matching
  // the shape of a real AWS STS temporary security_token.
  "security_token: FwoGZXIvYXdzEMb//////////wEaoA==",
  'security_token = "SECRETSECURITYTOKENHCLQUOTED1234567890"',
  '"security_token": "SECRETJSONSECURITYTOKEN1234567890"',
  '\\"security_token\\": \\"SECRETJSONSECURITYTOKENESCAPED1234567890\\"',
  '"security_token" = "SECRETJSONSECURITYTOKENEQUALS1234567890"',
  '\\"security_token\\" = \\"SECRETJSONSECURITYTOKENEQUALSESCAPED1234567890\\"',
  // Authorization = "Bot ..." / Authorization = Bot ... (quote optional).
  'Authorization = "Bot SECRETBOTTOKENQUOTED1234567890"',
  "Authorization = Bot SECRETBOTTOKENBARE1234567890",
  // ── terraform arrow-form updates: `attr = "OLD" -> "NEW"` ──
  // Terraform's plan renderer shows in-place value updates in this old-to-new
  // form. The value-matching patterns above only consume through the first
  // closing quote, so without a follow-up pass the NEW value on the right of
  // `->` survives redaction. One fixture per affected class, covering both
  // HCL and JSON-ish (plain + backslash-escaped-quote) variants.
  'security_token = "OLDARROWSECBAREHCL1234567890" -> "NEWARROWSECBAREHCL1234567890"',
  '"security_token": "OLDARROWSECJSONCOL1234567890" -> "NEWARROWSECJSONCOL1234567890"',
  '"security_token" = "OLDARROWSECJSONEQ1234567890" -> "NEWARROWSECJSONEQ1234567890"',
  '\\"security_token\\" = \\"OLDARROWSECESCEQ1234567890\\" -> \\"NEWARROWSECESCEQ1234567890\\"',
  'token = "OLDARROWTOKHCL1234567890" -> "NEWARROWTOKHCL1234567890"',
  '"token": "OLDARROWTOKJSONCOL1234567890" -> "NEWARROWTOKJSONCOL1234567890"',
  '\\"token\\": \\"OLDARROWTOKESCCOL1234567890\\" -> \\"NEWARROWTOKESCCOL1234567890\\"',
  "api_key = OLDARROWAPIKEYBARE1234567890 -> NEWARROWAPIKEYBARE1234567890",
  '"webhook_api_key": "OLDARROWAPIKEYJSONCOL1234567890" -> "NEWARROWAPIKEYJSONCOL1234567890"',
  '"webhook_api_key" = "OLDARROWAPIKEYJSONEQ1234567890" -> "NEWARROWAPIKEYJSONEQ1234567890"',
  // ── near-misses: must survive byte-identical ──
  "token_count = 5",
  'docs_url = "https://example.com/readme"',
  'api_keyspace = "innocuous-value-1234567890"',
  'discord_docs = "https://discord.com/developers/docs/intro"',
  'instance_type = "t2.micro" -> "t2.large"',
];

const tempDir = mkdtempSync(path.join(tmpdir(), "sanitize-tf-output-test-"));
let output;
try {
  const inputFile = path.join(tempDir, "input.txt");
  const outputFile = path.join(tempDir, "output.txt");
  writeFileSync(inputFile, FIXTURE_LINES.join("\n") + "\n");

  const result = spawnSync(script, [inputFile, outputFile], {
    encoding: "utf8",
  });
  assert(
    result.status === 0,
    `sanitize-terraform-output.sh exited ${result.status}: ${result.stderr}`,
  );
  output = readFileSync(outputFile, "utf8");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

// ── redaction classes ────────────────────────────────────────────────────────

test("redacts discord.com webhook URL without /api version", () => {
  assertIncludes(
    output,
    'webhook_url_a = "https://discord.com/api/webhooks/123456789012345678/[REDACTED]"',
    "discord.com webhook (no version) not redacted as expected",
  );
  assertNotIncludes(
    output,
    "SECRETDISCORDTOKENAAAA",
    "discord.com token leaked",
  );
});

test("redacts discord.com webhook URL with /api/v10", () => {
  assertIncludes(
    output,
    'webhook_url_b = "https://discord.com/api/v10/webhooks/123456789012345678/[REDACTED]"',
    "discord.com webhook (v10) not redacted as expected",
  );
  assertNotIncludes(
    output,
    "SECRETDISCORDTOKENBBBB",
    "discord.com v10 token leaked",
  );
});

test("redacts discordapp.com webhook URL without /api version", () => {
  assertIncludes(
    output,
    'webhook_url_c = "https://discordapp.com/api/webhooks/123456789012345678/[REDACTED]"',
    "discordapp.com webhook (no version) not redacted as expected",
  );
  assertNotIncludes(
    output,
    "SECRETDISCORDTOKENCCCC",
    "discordapp.com token leaked",
  );
});

test("redacts discordapp.com webhook URL with /api/v10", () => {
  assertIncludes(
    output,
    'webhook_url_d = "https://discordapp.com/api/v10/webhooks/123456789012345678/[REDACTED]"',
    "discordapp.com webhook (v10) not redacted as expected",
  );
  assertNotIncludes(
    output,
    "SECRETDISCORDTOKENDDDD",
    "discordapp.com v10 token leaked",
  );
});

test("redacts a VictorOps URL", () => {
  assertIncludes(
    output,
    'victorops_url = "[REDACTED]"',
    "VictorOps URL not redacted",
  );
  assertNotIncludes(output, "SECRETVICTOROPSTOKEN", "VictorOps token leaked");
});

test("redacts a Splunk URL", () => {
  assertIncludes(
    output,
    'splunk_url = "[REDACTED]"',
    "Splunk URL not redacted",
  );
  assertNotIncludes(output, "SECRETSPLUNKTOKEN1234", "Splunk token leaked");
});

test('redacts JSON "token": "..." (plain quotes)', () => {
  assertIncludes(
    output,
    '"token": "[REDACTED]"',
    "plain JSON token not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETJSONTOKENPLAIN1234567890",
    "plain JSON token leaked",
  );
});

test('redacts JSON \\"token\\": \\"...\\" (backslash-escaped quotes)', () => {
  assertIncludes(
    output,
    '\\"token\\": \\"[REDACTED]\\"',
    "escaped-quote JSON token not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETJSONTOKENESCAPED1234567890",
    "escaped-quote JSON token leaked",
  );
});

test('redacts HCL token = "..."', () => {
  assertIncludes(output, 'token = "[REDACTED]"', "HCL token not redacted");
  assertNotIncludes(
    output,
    "SECRETHCLTOKENVALUE1234567890",
    "HCL token leaked",
  );
});

test("redacts bare api_key in ':' form", () => {
  assertIncludes(
    output,
    "api_key: [REDACTED]",
    "bare api_key (colon) not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETBAREAPIKEYCOLON1234567890",
    "bare api_key (colon) leaked",
  );
});

test("redacts bare api_key in '=' form", () => {
  assertIncludes(
    output,
    "api_key = [REDACTED]",
    "bare api_key (equals) not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETBAREAPIKEYEQUALS1234567890",
    "bare api_key (equals) leaked",
  );
});

test("redacts JSON-quoted *api_key in ':' form (plain and escaped)", () => {
  assertIncludes(
    output,
    '"webhook_api_key": "[REDACTED]"',
    "JSON api_key (colon, plain) not redacted",
  );
  assertIncludes(
    output,
    '\\"webhook_api_key\\": \\"[REDACTED]\\"',
    "JSON api_key (colon, escaped) not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETJSONAPIKEYCOLON1234567890",
    "JSON api_key (colon, plain) leaked",
  );
  assertNotIncludes(
    output,
    "SECRETJSONAPIKEYCOLONESCAPED1234567890",
    "JSON api_key (colon, escaped) leaked",
  );
});

test("redacts JSON-quoted *api_key in '=' form", () => {
  assertIncludes(
    output,
    '"webhook_api_key" = "[REDACTED]"',
    "JSON api_key (equals) not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETJSONAPIKEYEQUALS1234567890",
    "JSON api_key (equals) leaked",
  );
});

test('redacts HCL *_key = "..."', () => {
  assertIncludes(output, 'splunk_key = "[REDACTED]"', "HCL *_key not redacted");
  assertNotIncludes(
    output,
    "SECRETHCLUNDERSCOREKEYVALUE1234567890",
    "HCL *_key leaked",
  );
});

test("redacts bare security_token in ':' form", () => {
  assertIncludes(
    output,
    "security_token: [REDACTED]",
    "security_token not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETSECURITYTOKENVALUE1234567890",
    "security_token leaked",
  );
});

test("redacts bare security_token in '=' form (unquoted)", () => {
  assertIncludes(
    output,
    "security_token = [REDACTED]",
    "bare equals-form security_token not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETSECURITYTOKENBAREEQUALS1234567890",
    "bare equals-form security_token leaked",
  );
});

test("redacts bare security_token with base64-ish characters (/, +, =)", () => {
  assertIncludes(
    output,
    "security_token: [REDACTED]\n",
    "base64-ish security_token value not fully redacted (character class too narrow)",
  );
  assertNotIncludes(
    output,
    "wEaoA==",
    "base64-ish security_token value partially leaked (character class too narrow)",
  );
});

test('redacts unquoted-key security_token = "..." (HCL quoted-value form)', () => {
  // Matched by the generic HCL `token = "..."` pattern, since "token" is a
  // substring suffix of "security_token" — verified against the real script
  // rather than assumed, since the two rules can otherwise look independent.
  assertIncludes(
    output,
    'security_token = "[REDACTED]"',
    "HCL-quoted security_token value not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETSECURITYTOKENHCLQUOTED1234567890",
    "HCL-quoted security_token value leaked",
  );
});

test("redacts JSON-quoted security_token in ':' form (plain and escaped)", () => {
  assertIncludes(
    output,
    '"security_token": "[REDACTED]"',
    "JSON security_token (plain) not redacted",
  );
  assertIncludes(
    output,
    '\\"security_token\\": \\"[REDACTED]\\"',
    "JSON security_token (escaped) not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETJSONSECURITYTOKEN1234567890",
    "JSON security_token (plain) leaked",
  );
  assertNotIncludes(
    output,
    "SECRETJSONSECURITYTOKENESCAPED1234567890",
    "JSON security_token (escaped) leaked",
  );
});

test("redacts JSON-quoted security_token in '=' form (plain and escaped)", () => {
  assertIncludes(
    output,
    '"security_token" = "[REDACTED]"',
    "JSON security_token (equals, plain) not redacted",
  );
  assertIncludes(
    output,
    '\\"security_token\\" = \\"[REDACTED]\\"',
    "JSON security_token (equals, escaped) not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETJSONSECURITYTOKENEQUALS1234567890",
    "JSON security_token (equals, plain) leaked",
  );
  assertNotIncludes(
    output,
    "SECRETJSONSECURITYTOKENEQUALSESCAPED1234567890",
    "JSON security_token (equals, escaped) leaked",
  );
});

test('redacts Authorization = "Bot ..." (quoted)', () => {
  assertIncludes(
    output,
    'Authorization = "Bot [REDACTED]"',
    "quoted Authorization Bot header not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETBOTTOKENQUOTED1234567890",
    "quoted Authorization Bot header leaked",
  );
});

test("redacts Authorization = Bot ... (unquoted)", () => {
  assertIncludes(
    output,
    "Authorization = Bot [REDACTED]",
    "unquoted Authorization Bot header not redacted",
  );
  assertNotIncludes(
    output,
    "SECRETBOTTOKENBARE1234567890",
    "unquoted Authorization Bot header leaked",
  );
});

// ── terraform arrow-form updates: `attr = "OLD" -> "NEW"` ───────────────────
// P1 finding: a rotated secret rendered by terraform's in-place update diff
// (`attr = "OLD" -> "NEW"`) leaked the NEW value because the value-matching
// patterns above stop at the first closing quote. These assert BOTH sides
// are redacted for every affected class.

test("redacts both sides of a bare-HCL security_token arrow update", () => {
  assertIncludes(
    output,
    'security_token = "[REDACTED]" -> "[REDACTED]"',
    "security_token arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "OLDARROWSECBAREHCL1234567890",
    "security_token arrow update leaked OLD value",
  );
  assertNotIncludes(
    output,
    "NEWARROWSECBAREHCL1234567890",
    "security_token arrow update leaked NEW value",
  );
});

test("redacts both sides of a JSON-colon security_token arrow update", () => {
  assertIncludes(
    output,
    '"security_token": "[REDACTED]" -> "[REDACTED]"',
    "JSON-colon security_token arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWSECJSONCOL1234567890",
    "JSON-colon security_token arrow update leaked NEW value",
  );
});

test("redacts both sides of a JSON-equals security_token arrow update", () => {
  assertIncludes(
    output,
    '"security_token" = "[REDACTED]" -> "[REDACTED]"',
    "JSON-equals security_token arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWSECJSONEQ1234567890",
    "JSON-equals security_token arrow update leaked NEW value",
  );
});

test("redacts both sides of an escaped-quote JSON-equals security_token arrow update", () => {
  assertIncludes(
    output,
    '\\"security_token\\" = \\"[REDACTED]\\" -> \\"[REDACTED]\\"',
    "escaped-quote security_token arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWSECESCEQ1234567890",
    "escaped-quote security_token arrow update leaked NEW value",
  );
});

test("redacts both sides of an HCL token arrow update", () => {
  assertIncludes(
    output,
    'token = "[REDACTED]" -> "[REDACTED]"',
    "HCL token arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWTOKHCL1234567890",
    "HCL token arrow update leaked NEW value",
  );
});

test("redacts both sides of a JSON-colon token arrow update", () => {
  assertIncludes(
    output,
    '"token": "[REDACTED]" -> "[REDACTED]"',
    "JSON-colon token arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWTOKJSONCOL1234567890",
    "JSON-colon token arrow update leaked NEW value",
  );
});

test("redacts both sides of an escaped-quote JSON-colon token arrow update", () => {
  assertIncludes(
    output,
    '\\"token\\": \\"[REDACTED]\\" -> \\"[REDACTED]\\"',
    "escaped-quote token arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWTOKESCCOL1234567890",
    "escaped-quote token arrow update leaked NEW value",
  );
});

test("redacts both sides of a bare api_key arrow update", () => {
  assertIncludes(
    output,
    "api_key = [REDACTED] -> [REDACTED]",
    "bare api_key arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWAPIKEYBARE1234567890",
    "bare api_key arrow update leaked NEW value",
  );
});

test("redacts both sides of a JSON-colon *api_key arrow update", () => {
  assertIncludes(
    output,
    '"webhook_api_key": "[REDACTED]" -> "[REDACTED]"',
    "JSON-colon api_key arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWAPIKEYJSONCOL1234567890",
    "JSON-colon api_key arrow update leaked NEW value",
  );
});

test("redacts both sides of a JSON-equals *api_key arrow update", () => {
  assertIncludes(
    output,
    '"webhook_api_key" = "[REDACTED]" -> "[REDACTED]"',
    "JSON-equals api_key arrow update not fully redacted",
  );
  assertNotIncludes(
    output,
    "NEWARROWAPIKEYJSONEQ1234567890",
    "JSON-equals api_key arrow update leaked NEW value",
  );
});

// ── near-misses: must survive byte-identical ────────────────────────────────

test("leaves a non-secret attribute arrow update untouched", () => {
  assertIncludes(
    output,
    'instance_type = "t2.micro" -> "t2.large"',
    "near-miss instance_type arrow update was altered",
  );
});

test("leaves token_count = 5 untouched", () => {
  assertIncludes(
    output,
    "token_count = 5",
    "near-miss token_count was altered",
  );
});

test("leaves a plain https URL untouched", () => {
  assertIncludes(
    output,
    'docs_url = "https://example.com/readme"',
    "near-miss plain URL was altered",
  );
});

test("leaves api_keyspace untouched", () => {
  assertIncludes(
    output,
    'api_keyspace = "innocuous-value-1234567890"',
    "near-miss api_keyspace was altered",
  );
});

test("leaves a non-webhook discord.com URL untouched", () => {
  assertIncludes(
    output,
    'discord_docs = "https://discord.com/developers/docs/intro"',
    "near-miss discord.com docs URL was altered",
  );
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n${passed + failed} tests: \x1b[32m${passed} passed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`,
);

if (failed > 0) {
  process.exit(1);
}
