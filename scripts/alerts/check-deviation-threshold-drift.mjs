#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THRESHOLDS_PATH = "shared-config/src/thresholds.ts";
const ALERTS_MAIN_PATH = "alerts/rules/main.tf";
const FPMM_RULES_PATH = "alerts/rules/rules-fpmms.tf";

// Only the constants Terraform actually mirrors. `DEVIATION_CRITICAL_RATIO`
// is intentionally absent: since ADR 0067 it is an analytics classification
// with no Grafana consumer, so there is nothing in `alerts/` to keep in sync.
const THRESHOLD_EXPORTS = {
  tolerance: "DEVIATION_TOLERANCE_RATIO",
  depletionCritical: "POOL_DEPLETION_CRITICAL_SHARE",
  depletionPage: "POOL_DEPLETION_PAGE_SHARE",
};

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberLiteral(value) {
  return `(?<![0-9A-Za-z_.+-])${escapeRegex(value)}(?![0-9A-Za-z_.+-])`;
}

function normalizeDecimalLiteral(value) {
  const [whole, fraction = ""] = value.split(".");
  const normalizedWhole = whole.replace(/^0+(?=[0-9])/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

function ratioToPercentLiteral(value) {
  const [whole, fraction = ""] = value.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || "0");
  let percentNumerator = (numerator - denominator) * 100n;
  const sign = percentNumerator < 0n ? "-" : "";
  if (percentNumerator < 0n) percentNumerator = -percentNumerator;

  const integer = percentNumerator / denominator;
  let remainder = percentNumerator % denominator;
  if (remainder === 0n) return `${sign}${integer}`;

  let decimals = "";
  while (remainder !== 0n && decimals.length < 12) {
    remainder *= 10n;
    decimals += remainder / denominator;
    remainder %= denominator;
  }
  return `${sign}${integer}.${decimals.replace(/0+$/, "")}`;
}

function extractQuotedLocal(source, name) {
  const match = source.match(
    new RegExp(`\\b${name}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`),
  );
  return match?.[1] ?? null;
}

function extractHeredocLocal(source, name) {
  const match = source.match(
    new RegExp(`\\b${name}\\s*=\\s*<<-EOT\\n([\\s\\S]*?)\\n\\s*EOT`),
  );
  return match?.[1] ?? null;
}

function contextPercentLiterals(fragment, context) {
  const literals = [];
  const pattern =
    /(?<![0-9.])([0-9]+(?:\.[0-9]+)?)%{1,2}\s+(tolerance|threshold)(?![A-Za-z])/g;
  for (const match of fragment.matchAll(pattern)) {
    if (match[2] === context) literals.push(match[1]);
  }
  return literals;
}

function allContextPercentLiteralsMatch(fragment, context, expected) {
  const literals = contextPercentLiterals(fragment, context);
  const normalizedExpected = normalizeDecimalLiteral(expected);
  return (
    literals.length > 0 &&
    literals.every(
      (literal) => normalizeDecimalLiteral(literal) === normalizedExpected,
    )
  );
}

function findBalancedBlock(source, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
  }
  return null;
}

function extractBlocks(source, blockType) {
  const blocks = [];
  const pattern = new RegExp(`(?:^|\\n)\\s*${blockType}\\s*\\{`, "g");
  for (const match of source.matchAll(pattern)) {
    const openBraceIndex = source.indexOf("{", match.index);
    const block = findBalancedBlock(source, openBraceIndex);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

function extractNamedRuleBlock(source, ruleName) {
  return (
    extractBlocks(source, "rule").find((block) =>
      new RegExp(`\\bname\\s*=\\s*"${escapeRegex(ruleName)}"`).test(block),
    ) ?? null
  );
}

function extractDataBlockByRefId(source, refId) {
  return (
    extractBlocks(source, "data").find((block) =>
      new RegExp(`\\bref_id\\s*=\\s*"${escapeRegex(refId)}"`).test(block),
    ) ?? null
  );
}

// Scope an evaluator check to one named rule's `threshold` data block, so a
// same-shaped evaluator on a neighbouring rule cannot satisfy it.
function thresholdBlockOf(ruleName) {
  return (source) => {
    const rule = extractNamedRuleBlock(source, ruleName);
    if (rule === null) return null;
    return extractDataBlockByRefId(rule, "threshold");
  };
}

// Whitespace that may cross a wrapped comment line, so `#` counts as spacing.
const GAP = "[\\s#]+";

// A number wrapped in Markdown backticks, as the banner writes its literals.
function quotedLiteral(value) {
  return "\\x60" + numberLiteral(value) + "\\x60";
}

function evaluatorPattern(literal, comparison) {
  return new RegExp(
    `evaluator\\s*=\\s*\\{\\s*params\\s*=\\s*\\[${numberLiteral(literal)}\\]\\s*,\\s*type\\s*=\\s*"${comparison}"`,
  );
}

function extractThreshold(source, exportName) {
  const match = source.match(
    new RegExp(
      `^\\s*export\\s+const\\s+${exportName}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*;`,
      "m",
    ),
  );
  if (!match) {
    throw new Error(`missing numeric export ${exportName}`);
  }
  return match[1];
}

function requiredChecks(thresholds) {
  const tolerancePercent = ratioToPercentLiteral(thresholds.tolerance);

  return [
    {
      file: FPMM_RULES_PATH,
      description: "warning Grafana threshold evaluator mirrors tolerance",
      extract: thresholdBlockOf("Deviation Breach"),
      pattern: evaluatorPattern(thresholds.tolerance, "gt"),
    },
    {
      file: ALERTS_MAIN_PATH,
      description: "warning annotation mirrors warning tolerance percent",
      extract: (source) =>
        extractHeredocLocal(source, "deviation_warning_summary_annotation"),
      validate: (fragment) =>
        allContextPercentLiteralsMatch(fragment, "tolerance", tolerancePercent),
    },
    {
      file: FPMM_RULES_PATH,
      description:
        "depletion critical evaluator mirrors the critical side share",
      extract: thresholdBlockOf("Pool Depletion Risk"),
      pattern: evaluatorPattern(thresholds.depletionCritical, "lt"),
    },
    {
      file: FPMM_RULES_PATH,
      description: "depletion page evaluator mirrors the page side share",
      extract: thresholdBlockOf("Pool Nearly One-Sided"),
      pattern: evaluatorPattern(thresholds.depletionPage, "lt"),
    },
    {
      // The critical band floors where the page band ends. Drift here would
      // silently open a gap (a pool in neither band) or an overlap (one pool,
      // two notifications), which is exactly what the partition prevents.
      file: ALERTS_MAIN_PATH,
      description: "depletion critical band floors at the page side share",
      extract: (source) =>
        extractQuotedLocal(source, "pool_depletion_critical_active_promql"),
      pattern: new RegExp(`>=\\s*${numberLiteral(thresholds.depletionPage)}`),
    },
    {
      // The banner is the first thing a reader of rules-fpmms.tf sees, so it
      // has to name the live literals. `GAP` spans comment-continuation `#`
      // characters because the sentence wraps across comment lines.
      file: FPMM_RULES_PATH,
      description: "threshold banner names every mirrored literal",
      pattern: new RegExp(
        [
          "bare",
          GAP,
          quotedLiteral(thresholds.tolerance),
          GAP,
          "\\(deviation tolerance\\),",
          GAP,
          quotedLiteral(thresholds.depletionCritical),
          GAP,
          "\\(pool",
          GAP,
          "depletion critical side share\\)",
          GAP,
          "and",
          GAP,
          quotedLiteral(thresholds.depletionPage),
          GAP,
          "\\(pool",
          GAP,
          "depletion page side share\\)",
        ].join(""),
      ),
    },
  ];
}

export function validateDeviationThresholdDrift(sources) {
  const thresholdsSource = sources[THRESHOLDS_PATH];
  if (thresholdsSource === undefined) {
    throw new Error(`missing source: ${THRESHOLDS_PATH}`);
  }

  const thresholds = Object.fromEntries(
    Object.entries(THRESHOLD_EXPORTS).map(([key, exportName]) => [
      key,
      extractThreshold(thresholdsSource, exportName),
    ]),
  );

  const failures = [];
  for (const check of requiredChecks(thresholds)) {
    const source = sources[check.file];
    if (source === undefined) {
      failures.push(`${check.file}: missing source`);
      continue;
    }
    const fragment = check.extract ? check.extract(source) : source;
    if (fragment === null) {
      failures.push(`${check.file}: missing source for ${check.description}`);
      continue;
    }
    if (check.pattern && !check.pattern.test(fragment)) {
      failures.push(
        `${check.file}: expected ${check.description} (${check.pattern.source})`,
      );
    }
    if (check.validate && !check.validate(fragment)) {
      failures.push(`${check.file}: expected ${check.description}`);
    }
  }

  return { failures, thresholds };
}

function readRepoSources(root) {
  return Object.fromEntries(
    [THRESHOLDS_PATH, ALERTS_MAIN_PATH, FPMM_RULES_PATH].map((path) => [
      path,
      readFileSync(resolve(root, path), "utf8"),
    ]),
  );
}

function main() {
  const { failures, thresholds } = validateDeviationThresholdDrift(
    readRepoSources(repoRoot()),
  );
  if (failures.length > 0) {
    console.error(
      "Alert threshold drift check failed. Mirror shared-config/src/thresholds.ts into alerts/rules/main.tf and alerts/rules/rules-fpmms.tf.",
    );
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Alert threshold drift check OK: tolerance=${thresholds.tolerance}, depletion critical=${thresholds.depletionCritical}, depletion page=${thresholds.depletionPage}`,
  );
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  main();
}
