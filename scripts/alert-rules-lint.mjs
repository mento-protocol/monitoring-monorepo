#!/usr/bin/env node
/**
 * Static checks for the Grafana alert-rule stack in alerts/rules/.
 *
 * 1. PromQL syntax lint: extracts every PromQL expression embedded in the .tf
 *    files (expr attributes, *_promql / *_expr locals, format() templates,
 *    join() fragment lists, heredocs), neutralizes Terraform templating, and
 *    parses each expression with the Prometheus lezer grammar in strict mode.
 * 2. Metric cross-check: every mento_pool_* / mento_cdp_* / mento_peg_* series name
 *    referenced in alerts/rules must be registered in metrics-bridge.
 * 3. Peg policy cross-check: the gated threshold bundle is structurally strict,
 *    matches the service registry exactly, and keeps every peg PromQL selector
 *    bound to the accepted policy version set.
 *
 * The extractor is regex-based, not an HCL evaluator. The count floors
 * (ALERT_RULES_LINT_MIN_*) fail loudly if a future .tf refactor moves
 * expressions into shapes the extractor no longer sees; extend the extractor
 * instead of lowering the floor.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parser } from "@prometheus-io/lezer-promql";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const rulesDir =
  process.env.ALERT_RULES_LINT_RULES_DIR ?? path.join(repoRoot, "alerts/rules");
const metricsSrcDir =
  process.env.ALERT_RULES_LINT_METRICS_DIR ??
  path.join(repoRoot, "metrics-bridge/src");
const pegPolicyPath =
  process.env.ALERT_RULES_LINT_PEG_POLICY ??
  path.join(rulesDir, "peg-thresholds.json");
const pegRegistryPath =
  process.env.ALERT_RULES_LINT_PEG_REGISTRY ??
  path.join(repoRoot, "metrics-bridge/peg-registry.json");
const GAUGE_SOURCE_FILES = ["metrics.ts", "cdp-metrics.ts", "peg/metrics.ts"];
const LITERAL_PERCENT = "__ALERT_RULES_LINT_LITERAL_PERCENT__";

const POLICY_BUNDLE_KEYS = ["schemaVersion", "active", "previous"];
const POLICY_VERSION_KEYS = ["version", "rolloverAckExpectedSeconds", "assets"];
const POLICY_ASSET_KEYS = [
  "target",
  "warnDeviationBps",
  "criticalDeviationBps",
  "premiumWarnBps",
  "warnSustainSeconds",
  "criticalSustainSeconds",
  "durationQuantile",
  "minimumCoverageFraction",
  "blindConsecutivePolls",
  "permanentlyDeadSeconds",
  "structuralWarnFraction",
  "freshnessGraceSeconds",
  "deepVenueSource",
  "sources",
];
const POLICY_SOURCE_KEYS = [
  "authority",
  "referenceSizeCap",
  "pollIntervalSeconds",
  "staleAfterSeconds",
  "listingAbsentConsecutiveChecks",
  "spreadEnvelopeBps",
  "conversionErrorBps",
];
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const POLICY_VERSION_DIGEST_PATTERN = /-([0-9a-f]{32})$/;
const MAX_POLICY_ASSETS = 32;
const MAX_POLICY_SOURCES = 16;
const LEGACY_LISTING_ABSENT_CONSECUTIVE_CHECKS_VERSION =
  "europ-2026-07-22-v1-a69b99aad61649957a2639dc8348b05f";
const APPROVED_POLICY_VERSION_INTERPOLATION = {
  active: "${local.peg_active_policy_version}",
  previous: "${local.peg_previous_policy_version}",
};
const SOURCE_AUTHORITY_BY_REGISTRY_ROLE = {
  primary: "deep",
  secondary: "secondary",
  display: "display",
};

const ASSET_NUMBER_RULES = [
  ["target", { greaterThan: 0 }],
  ["warnDeviationBps", { greaterThan: 0, maximum: 10_000 }],
  ["criticalDeviationBps", { greaterThan: 0, maximum: 10_000 }],
  ["premiumWarnBps", { greaterThan: 0, maximum: 10_000 }],
  ["warnSustainSeconds", { integer: true, minimum: 60, maximum: 86_400 }],
  ["criticalSustainSeconds", { integer: true, minimum: 60, maximum: 86_400 }],
  ["durationQuantile", { greaterThan: 0, lessThan: 1 }],
  ["minimumCoverageFraction", { greaterThan: 0, maximum: 1 }],
  ["blindConsecutivePolls", { integer: true, minimum: 1, maximum: 1_000 }],
  [
    "permanentlyDeadSeconds",
    { integer: true, minimum: 86_400, maximum: 31_536_000 },
  ],
  ["structuralWarnFraction", { greaterThan: 0, maximum: 1 }],
  ["freshnessGraceSeconds", { integer: true, minimum: 60, maximum: 3_600 }],
];

const SOURCE_NUMBER_RULES = [
  ["referenceSizeCap", { greaterThan: 0 }],
  ["pollIntervalSeconds", { integer: true, minimum: 15, maximum: 3_600 }],
  ["staleAfterSeconds", { integer: true, minimum: 1, maximum: 86_400 }],
  [
    "listingAbsentConsecutiveChecks",
    { integer: true, minimum: 2, maximum: 1_000 },
  ],
  ["spreadEnvelopeBps", { minimum: 0, maximum: 10_000 }],
  ["conversionErrorBps", { minimum: 0, maximum: 10_000 }],
];

function effectiveListingAbsentConsecutiveChecks(source) {
  return source.listingAbsentConsecutiveChecks ?? 2;
}

const intEnv = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number.parseInt(raw, 10);
};

// An HCL double-quoted string body. Handles \" escapes inside jsonencode.
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;

// Peg rollover scope is carried by a reserved Terraform-local name so the
// production extractor and the semantic validator share one executable path.
// Inline `expr` attributes remain intentionally unscoped and fail closed when
// a previous policy is retained.
function pegRuleForExpressionName(name) {
  if (/^peg_rollover_ack_[a-z0-9_]+_(?:promql|expr)$/.test(name)) {
    return { kind: "rollover-ack" };
  }
  const decision = /^peg_(active|previous)_[a-z0-9_]+_(?:promql|expr)$/.exec(
    name,
  );
  return decision === null
    ? undefined
    : { kind: "decision", policy: decision[1] };
}

function extractedExpression(file, kind, name, expr) {
  const pegRule = pegRuleForExpressionName(name);
  return pegRule === undefined
    ? { file, kind, expr }
    : { file, kind, expr, pegRule };
}

function stripLineComment(line) {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "#") {
      return line.slice(0, i).trimEnd();
    } else if (char === "/" && line[i + 1] === "/") {
      return line.slice(0, i).trimEnd();
    }
  }

  return line;
}

export const stripComments = (text) =>
  text.split("\n").map(stripLineComment).join("\n");

export const unescapeHcl = (value) => value.replace(/\\(["\\])/g, "$1");

// Make a Terraform-templated expression parseable as plain PromQL. Terraform
// ${...} interpolations and %s format verbs become a placeholder metric
// selector; numeric format verbs become a literal 1; %% is Terraform's escaped
// literal percent and becomes PromQL's modulo operator.
export const neutralize = (expr) =>
  expr
    .replace(/%%/g, LITERAL_PERCENT)
    .replace(/\$\{[^}]+\}/g, "placeholder_metric")
    .replace(/%s/g, "placeholder_metric")
    .replace(/%[dfg]/g, "1")
    .replaceAll(LITERAL_PERCENT, "%");

function findClosingBracket(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractJoinExpressions(file, text) {
  const out = [];
  const assignment = /^\s*(expr|[A-Za-z0-9_]*_(?:promql|expr))\s*=/gm;
  for (const match of text.matchAll(assignment)) {
    const name = match[1];
    const bodyStart = match.index + match[0].length;
    const nextAssignment = /^\s*[A-Za-z0-9_]+\s*=/gm;
    nextAssignment.lastIndex = bodyStart;
    const next = nextAssignment.exec(text);
    const bodyEnd = next ? next.index : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    const joinCall = new RegExp(String.raw`join\(\s*${QUOTED}\s*,\s*\[`, "g");

    for (const join of body.matchAll(joinCall)) {
      const separator = unescapeHcl(join[1]);
      const open = join.index + join[0].lastIndexOf("[");
      const close = findClosingBracket(body, open);
      if (close === -1) continue;

      const listBody = body.slice(open + 1, close);
      const elem = new RegExp(String.raw`^\s*${QUOTED},?\s*$`, "gm");
      const fragments = [];
      for (const element of listBody.matchAll(elem)) {
        const fragment = unescapeHcl(element[1]);
        fragments.push(fragment);
        out.push(extractedExpression(file, "join-elem", name, fragment));
      }
      if (fragments.length > 0) {
        out.push(
          extractedExpression(file, "join", name, fragments.join(separator)),
        );
      }
    }
  }

  return out;
}

// `text` must already be comment-stripped.
export function extractExpressions(file, text) {
  const out = [];

  // Pass A: single-line `expr = "..."` and `*_promql` / `*_expr` locals.
  const single = new RegExp(
    String.raw`^\s*(expr|[A-Za-z0-9_]*_(?:promql|expr))\s*=\s*${QUOTED}\s*,?\s*$`,
    "gm",
  );
  for (const match of text.matchAll(single)) {
    out.push(
      extractedExpression(file, "single", match[1], unescapeHcl(match[2])),
    );
  }

  // Pass B: format() templates (inline or template on the next line). Skip
  // *_regex* locals (label-regex builders, not PromQL); accept `expr`,
  // `*_promql` / `*_expr` names, and PascalCase duration-part map keys.
  const fmt = new RegExp(
    String.raw`^\s*([A-Za-z0-9_]+)\s*=\s*format\(\s*\n?\s*${QUOTED}`,
    "gm",
  );
  for (const match of text.matchAll(fmt)) {
    const name = match[1];
    if (/_regex/.test(name)) continue;
    if (
      name !== "expr" &&
      !/_(promql|expr)$/.test(name) &&
      !/^[A-Z][A-Za-z0-9]*$/.test(name)
    ) {
      continue;
    }
    out.push(extractedExpression(file, "format", name, unescapeHcl(match[2])));
  }

  // Pass C: heredocs assigned to expr / *_promql / *_expr.
  const heredoc = new RegExp(
    String.raw`^\s*(expr|[A-Za-z0-9_]*_(?:promql|expr))\s*=\s*<<-?EOT\n([\s\S]*?)^\s*EOT$`,
    "gm",
  );
  for (const match of text.matchAll(heredoc)) {
    out.push(extractedExpression(file, "heredoc", match[1], match[2]));
  }

  // Pass D: quoted fragments of join("...", [ ... ]) lists inside expr
  // assignments, including format(..., join(...)) wrappers. HCL has no raw
  // string escapes inside the bracket list, so scan for the matching closing
  // bracket while ignoring PromQL range-selector brackets inside quoted
  // fragments.
  out.push(...extractJoinExpressions(file, text));

  return out;
}

const strictParser = parser.configure({ strict: true });

/** Returns null when `expr` parses, otherwise the parser error message. */
export function lintPromql(expr) {
  try {
    strictParser.parse(expr);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const registeredMetricNames = (tsSource) =>
  [...tsSource.matchAll(/name:\s*"(mento_[a-z0-9_]+)"/g)].map(
    (match) => match[1],
  );

export const referencedMetricNames = (tfSource) =>
  [...tfSource.matchAll(/\bmento_(?:pool|cdp|peg)_[a-z0-9_]*[a-z0-9]\b/g)].map(
    (match) => match[0],
  );

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recursivelySortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(recursivelySortObjectKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, recursivelySortObjectKeys(value[key])]),
  );
}

export function pegPolicyVersionDigest(policyVersion) {
  if (!isObject(policyVersion)) return null;
  const content = Object.fromEntries(
    Object.entries(policyVersion).filter(([key]) => key !== "version"),
  );
  return createHash("sha256")
    .update(JSON.stringify(recursivelySortObjectKeys(content)))
    .digest("hex")
    .slice(0, 32);
}

function validatePolicyVersionDigest(policy, location, failures) {
  if (typeof policy.version !== "string") return;
  const suffix = POLICY_VERSION_DIGEST_PATTERN.exec(policy.version)?.[1];
  const expected = pegPolicyVersionDigest(policy);
  if (suffix === undefined) {
    failures.push(
      `${location}.version: must end with the first 32 lowercase hex characters of the SHA-256 policy-content digest`,
    );
  } else if (suffix !== expected) {
    failures.push(
      `${location}.version: digest suffix ${suffix} does not match policy content ${expected}`,
    );
  }
}

function validateExactObject(value, expectedKeys, location, failures) {
  if (!isObject(value)) {
    failures.push(`${location}: expected an object`);
    return false;
  }

  const actual = new Set(Object.keys(value));
  for (const key of expectedKeys) {
    if (!actual.has(key)) failures.push(`${location}: missing ${key}`);
  }
  for (const key of actual) {
    if (!expectedKeys.includes(key)) {
      failures.push(`${location}: unknown field ${key}`);
    }
  }
  return true;
}

function validateNumber(value, location, rule, failures) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failures.push(`${location}: expected a finite number`);
    return;
  }
  if (rule.integer && !Number.isInteger(value)) {
    failures.push(`${location}: expected an integer`);
  }
  if (rule.greaterThan !== undefined && value <= rule.greaterThan) {
    failures.push(`${location}: must be > ${rule.greaterThan}`);
  }
  if (rule.minimum !== undefined && value < rule.minimum) {
    failures.push(`${location}: must be >= ${rule.minimum}`);
  }
  if (rule.maximum !== undefined && value > rule.maximum) {
    failures.push(`${location}: must be <= ${rule.maximum}`);
  }
  if (rule.lessThan !== undefined && value >= rule.lessThan) {
    failures.push(`${location}: must be < ${rule.lessThan}`);
  }
}

function validateNumberFields(value, location, rules, failures) {
  for (const [field, rule] of rules) {
    validateNumber(value[field], `${location}.${field}`, rule, failures);
  }
}

function collectRegistrySources(registryAsset, location, failures) {
  const sources = new Map();
  if (!isObject(registryAsset) || !Array.isArray(registryAsset.sources)) {
    failures.push(`${location}.sources: expected an array`);
    return sources;
  }

  for (const [index, source] of registryAsset.sources.entries()) {
    const sourceLocation = `${location}.sources[${index}]`;
    if (!isObject(source)) {
      failures.push(`${sourceLocation}: expected an object`);
      continue;
    }
    if (typeof source.id !== "string" || source.id.length === 0) {
      failures.push(`${sourceLocation}.id: expected a non-empty string`);
      continue;
    }
    if (sources.has(source.id)) {
      failures.push(`${location}.sources: duplicate source id ${source.id}`);
      continue;
    }
    if (!(source.role in SOURCE_AUTHORITY_BY_REGISTRY_ROLE)) {
      failures.push(`${sourceLocation}.role: unsupported role ${source.role}`);
    }
    sources.set(source.id, source);
  }
  return sources;
}

function validatePolicySource(
  source,
  registrySource,
  location,
  failures,
  allowLegacyThreshold,
) {
  const hasListingThreshold = Object.hasOwn(
    source,
    "listingAbsentConsecutiveChecks",
  );
  const expectedKeys =
    allowLegacyThreshold && !hasListingThreshold
      ? POLICY_SOURCE_KEYS.filter(
          (key) => key !== "listingAbsentConsecutiveChecks",
        )
      : POLICY_SOURCE_KEYS;
  if (!validateExactObject(source, expectedKeys, location, failures)) {
    return;
  }
  validateNumberFields(
    source,
    location,
    allowLegacyThreshold && !hasListingThreshold
      ? SOURCE_NUMBER_RULES.filter(
          ([field]) => field !== "listingAbsentConsecutiveChecks",
        )
      : SOURCE_NUMBER_RULES,
    failures,
  );

  const expectedAuthority =
    SOURCE_AUTHORITY_BY_REGISTRY_ROLE[registrySource?.role];
  if (
    !Object.values(SOURCE_AUTHORITY_BY_REGISTRY_ROLE).includes(source.authority)
  ) {
    failures.push(
      `${location}.authority: unsupported value ${source.authority}`,
    );
  } else if (
    expectedAuthority !== undefined &&
    source.authority !== expectedAuthority
  ) {
    failures.push(
      `${location}.authority: expected ${expectedAuthority} for registry role ${registrySource.role}`,
    );
  }

  if (
    Number.isFinite(source.pollIntervalSeconds) &&
    Number.isFinite(source.staleAfterSeconds) &&
    source.staleAfterSeconds <
      source.pollIntervalSeconds *
        effectiveListingAbsentConsecutiveChecks(source)
  ) {
    failures.push(
      `${location}.staleAfterSeconds: must cover pollIntervalSeconds * listingAbsentConsecutiveChecks`,
    );
  }
}

function validatePolicySources(
  asset,
  registryAsset,
  location,
  failures,
  registryAligned,
  allowLegacyListingThreshold,
) {
  const registrySources = registryAligned
    ? collectRegistrySources(registryAsset, `registry.${location}`, failures)
    : new Map();
  const sourceIds = registryAligned
    ? [...registrySources.keys()].sort()
    : isObject(asset.sources)
      ? Object.keys(asset.sources).sort()
      : [];
  if (registryAligned) {
    if (
      !validateExactObject(
        asset.sources,
        sourceIds,
        `${location}.sources`,
        failures,
      )
    ) {
      return;
    }
  } else if (!isObject(asset.sources)) {
    failures.push(`${location}.sources: expected an object`);
    return;
  }
  if (sourceIds.length === 0) {
    failures.push(`${location}.sources: expected at least one source`);
  }
  if (sourceIds.length > MAX_POLICY_SOURCES) {
    failures.push(
      `${location}.sources: expected at most ${MAX_POLICY_SOURCES} sources`,
    );
  }

  let deepSourceCount = 0;
  for (const sourceId of sourceIds) {
    const source = asset.sources[sourceId];
    if (!isObject(source)) continue;
    validatePolicySource(
      source,
      registrySources.get(sourceId),
      `${location}.sources.${sourceId}`,
      failures,
      allowLegacyListingThreshold,
    );
    if (source.authority === "deep") deepSourceCount += 1;
  }

  if (deepSourceCount !== 1) {
    failures.push(`${location}.sources: expected exactly one deep venue`);
  }
  if (
    typeof asset.deepVenueSource !== "string" ||
    asset.deepVenueSource.length === 0
  ) {
    failures.push(`${location}.deepVenueSource: expected a non-empty string`);
  } else if (asset.sources[asset.deepVenueSource]?.authority !== "deep") {
    failures.push(
      `${location}.deepVenueSource: must name the one deep-authority source`,
    );
  }

  const pollIntervals = Object.values(asset.sources)
    .map((source) => source?.pollIntervalSeconds)
    .filter(Number.isFinite);
  const maximumPollInterval = Math.max(0, ...pollIntervals);
  if (asset.freshnessGraceSeconds < maximumPollInterval) {
    failures.push(
      `${location}.freshnessGraceSeconds: must cover the slowest source poll interval`,
    );
  }
}

function validateThresholdRelationships(asset, location, failures) {
  if (asset.criticalDeviationBps <= asset.warnDeviationBps) {
    failures.push(
      `${location}.criticalDeviationBps: must be greater than warnDeviationBps`,
    );
  }
  if (asset.criticalSustainSeconds < asset.warnSustainSeconds) {
    failures.push(
      `${location}.criticalSustainSeconds: must be >= warnSustainSeconds`,
    );
  }
  if (asset.permanentlyDeadSeconds <= asset.freshnessGraceSeconds) {
    failures.push(
      `${location}.permanentlyDeadSeconds: must exceed freshnessGraceSeconds`,
    );
  }
}

function validatePolicyAsset(
  asset,
  registryAsset,
  location,
  failures,
  registryAligned,
  allowLegacyListingThreshold,
) {
  if (!validateExactObject(asset, POLICY_ASSET_KEYS, location, failures)) {
    return;
  }
  validateNumberFields(asset, location, ASSET_NUMBER_RULES, failures);
  validateThresholdRelationships(asset, location, failures);
  validatePolicySources(
    asset,
    registryAsset,
    location,
    failures,
    registryAligned,
    allowLegacyListingThreshold,
  );
}

function validatePolicyVersion(
  policy,
  registry,
  location,
  failures,
  registryAligned,
) {
  if (!validateExactObject(policy, POLICY_VERSION_KEYS, location, failures)) {
    return;
  }
  if (
    typeof policy.version !== "string" ||
    !POLICY_VERSION_PATTERN.test(policy.version)
  ) {
    failures.push(
      `${location}.version: expected a non-empty identifier using letters, digits, dot, underscore, or hyphen`,
    );
  }
  validatePolicyVersionDigest(policy, location, failures);
  validateNumber(
    policy.rolloverAckExpectedSeconds,
    `${location}.rolloverAckExpectedSeconds`,
    { integer: true, minimum: 30, maximum: 3_600 },
    failures,
  );

  if (registryAligned && !isObject(registry)) {
    failures.push("peg registry: expected an object");
    return;
  }
  if (!isObject(policy.assets)) {
    failures.push(`${location}.assets: expected an object`);
    return;
  }
  const assetIds = registryAligned
    ? Object.keys(registry).sort()
    : Object.keys(policy.assets).sort();
  if (
    registryAligned &&
    !validateExactObject(
      policy.assets,
      assetIds,
      `${location}.assets`,
      failures,
    )
  ) {
    return;
  }
  if (assetIds.length === 0) {
    failures.push(`${location}.assets: expected at least one asset`);
  }
  if (assetIds.length > MAX_POLICY_ASSETS) {
    failures.push(
      `${location}.assets: expected at most ${MAX_POLICY_ASSETS} assets`,
    );
  }
  for (const assetId of assetIds) {
    validatePolicyAsset(
      policy.assets[assetId],
      registryAligned ? registry[assetId] : undefined,
      `${location}.assets.${assetId}`,
      failures,
      registryAligned,
      !registryAligned &&
        policy.version === LEGACY_LISTING_ABSENT_CONSECUTIVE_CHECKS_VERSION,
    );
  }
}

export function validatePegPolicyBundle(bundle, registry) {
  const failures = [];
  if (
    !validateExactObject(bundle, POLICY_BUNDLE_KEYS, "peg policy", failures)
  ) {
    return failures;
  }
  if (bundle.schemaVersion !== 1) {
    failures.push("peg policy.schemaVersion: expected 1");
  }

  validatePolicyVersion(
    bundle.active,
    registry,
    "peg policy.active",
    failures,
    true,
  );
  if (bundle.previous !== null) {
    validatePolicyVersion(
      bundle.previous,
      registry,
      "peg policy.previous",
      failures,
      false,
    );
    if (bundle.previous?.version === bundle.active?.version) {
      failures.push(
        "peg policy.previous.version: must differ from active.version",
      );
    }
  }
  return failures;
}

function readSelector(expression, metricEnd) {
  let cursor = metricEnd;
  while (/\s/.test(expression[cursor] ?? "")) cursor += 1;
  if (expression[cursor] !== "{") return null;

  let inString = false;
  let escaped = false;
  for (let index = cursor + 1; index < expression.length; index += 1) {
    const char = expression[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "}") {
      return expression.slice(cursor, index + 1);
    }
  }
  return expression.slice(cursor);
}

function pegMetricSelectors(expression) {
  const selectors = [];
  const metric = /\bmento_peg_[a-z0-9_]*[a-z0-9]\b/g;
  for (const match of expression.matchAll(metric)) {
    selectors.push({
      metric: match[0],
      selector: readSelector(expression, match.index + match[0].length),
    });
  }
  return selectors;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unwrapVersionRegex(value) {
  let body = value;
  if (body.startsWith("^") && body.endsWith("$")) body = body.slice(1, -1);
  if (body.startsWith("(?:") && body.endsWith(")")) {
    body = body.slice(3, -1);
  } else if (body.startsWith("(") && body.endsWith(")")) {
    body = body.slice(1, -1);
  }
  return body.split("|");
}

function isExactVersionMatcher(operator, value, expectedVersion, policySlot) {
  // Terraform-generated rules may inject only the reviewed exact-version
  // local for their policy slot. Arbitrary whole-value interpolation remains
  // a bypass because the linter cannot prove its value.
  if (value === APPROVED_POLICY_VERSION_INTERPOLATION[policySlot]) {
    return operator === "=";
  }
  if (operator === "=") {
    return expectedVersion === value;
  }

  const expected = new Set([escapeRegex(expectedVersion)]);
  const actual = new Set(unwrapVersionRegex(value));
  return (
    actual.size === expected.size &&
    [...actual].every((item) => expected.has(item))
  );
}

function validatePegSelector(
  selector,
  metric,
  expectedVersion,
  policySlot,
  location,
  failures,
) {
  if (selector === null) {
    failures.push(
      `${location}: ${metric} is missing a policy_version selector`,
    );
    return;
  }
  const matchers = [
    ...selector.matchAll(
      /\bpolicy_version\s*(!=|!~|=~|=)\s*"((?:[^"\\]|\\.)*)"/g,
    ),
  ];
  if (matchers.length === 0) {
    failures.push(`${location}: ${metric} is missing a policy_version matcher`);
    return;
  }
  if (matchers.length > 1) {
    failures.push(
      `${location}: ${metric} must have exactly one positive policy_version matcher`,
    );
    return;
  }
  const [, operator, value] = matchers[0];
  if (operator === "!=" || operator === "!~") {
    failures.push(
      `${location}: ${metric} must not narrow the accepted policy versions with a negative matcher`,
    );
    return;
  }
  if (!isExactVersionMatcher(operator, value, expectedVersion, policySlot)) {
    failures.push(
      `${location}: ${metric} policy_version matcher must equal ${policySlot} version ${expectedVersion}`,
    );
  }
}

function validatePegRuleScope(expression, policyVersions, selectors, failures) {
  const location = `${expression.file} [${expression.kind}]`;
  const scope = expression.pegRule;
  if (scope === undefined) {
    if (policyVersions.previous !== null && selectors.length > 0) {
      failures.push(
        `${location}: rollover peg expression must declare pegRule as an active/previous decision or rollover-ack rule`,
      );
    }
    return { kind: "decision", policy: "active" };
  }
  if (!isObject(scope)) {
    failures.push(`${location}: pegRule must be an object`);
    return { kind: "decision", policy: "active" };
  }
  if (scope.kind === "rollover-ack") {
    for (const { metric } of selectors) {
      if (metric !== "mento_peg_policy_version") {
        failures.push(
          `${location}: rollover-ack rule may select only mento_peg_policy_version, found ${metric}`,
        );
      }
    }
    return scope;
  }
  if (
    scope.kind !== "decision" ||
    (scope.policy !== "active" && scope.policy !== "previous")
  ) {
    failures.push(
      `${location}: pegRule decision must name policy active or previous`,
    );
    return { kind: "decision", policy: "active" };
  }
  if (scope.policy === "previous" && policyVersions.previous === null) {
    failures.push(
      `${location}: previous decision rule is invalid without a retained previous policy`,
    );
  }
  return scope;
}

export function validatePegPromqlExpressions(expressions, policyVersions) {
  const failures = [];
  if (
    !isObject(policyVersions) ||
    typeof policyVersions.active !== "string" ||
    !(
      policyVersions.previous === null ||
      typeof policyVersions.previous === "string"
    )
  ) {
    return [
      "peg PromQL validation: expected { active: string, previous: string | null } policy versions",
    ];
  }
  for (const expression of expressions) {
    const { file, kind, expr } = expression;
    const location = `${file} [${kind}]`;
    const selectors = pegMetricSelectors(expr);
    const scope = validatePegRuleScope(
      expression,
      policyVersions,
      selectors,
      failures,
    );
    for (const { metric, selector } of selectors) {
      const policySlot =
        metric === "mento_peg_policy_version" || scope.kind === "rollover-ack"
          ? "active"
          : scope.policy;
      const expectedVersion = policyVersions[policySlot];
      if (typeof expectedVersion !== "string") continue;
      validatePegSelector(
        selector,
        metric,
        expectedVersion,
        policySlot,
        location,
        failures,
      );
    }
  }
  return failures;
}

function readJson(file, label, failures) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function policyVersions(bundle) {
  return {
    active: isObject(bundle?.active) ? bundle.active.version : "",
    previous: isObject(bundle?.previous) ? bundle.previous.version : null,
  };
}

function main() {
  const minExpressions = intEnv("ALERT_RULES_LINT_MIN_EXPRESSIONS", 100);
  const minRegistered = intEnv("ALERT_RULES_LINT_MIN_REGISTERED", 30);
  const minReferenced = intEnv("ALERT_RULES_LINT_MIN_REFERENCED", 25);

  const failures = [];
  const referenced = new Set();
  let expressions = [];

  const pegPolicy = readJson(pegPolicyPath, "peg policy", failures);
  const pegRegistry = readJson(pegRegistryPath, "peg registry", failures);
  if (pegPolicy !== null && pegRegistry !== null) {
    failures.push(...validatePegPolicyBundle(pegPolicy, pegRegistry));
  }
  const tfFiles = readdirSync(rulesDir)
    .filter((file) => file.endsWith(".tf"))
    .sort();

  for (const file of tfFiles) {
    const cleaned = stripComments(
      readFileSync(path.join(rulesDir, file), "utf8"),
    );
    expressions.push(...extractExpressions(file, cleaned));
    for (const name of referencedMetricNames(cleaned)) referenced.add(name);
  }

  for (const { file, kind, expr } of expressions) {
    const neutralized = neutralize(expr);
    const errorMessage = lintPromql(neutralized);
    if (errorMessage !== null) {
      failures.push(
        `${file} [${kind}]: ${errorMessage}\n      ${neutralized.trim()}`,
      );
    }
  }
  failures.push(
    ...validatePegPromqlExpressions(expressions, policyVersions(pegPolicy)),
  );

  const registered = new Set();
  for (const file of GAUGE_SOURCE_FILES) {
    const source = readFileSync(path.join(metricsSrcDir, file), "utf8");
    for (const name of registeredMetricNames(source)) registered.add(name);
  }

  for (const name of [...referenced].sort()) {
    if (!registered.has(name)) {
      failures.push(
        `unknown metric in alerts/rules: ${name} is not registered in metrics-bridge (${GAUGE_SOURCE_FILES.join(", ")})`,
      );
    }
  }

  if (expressions.length < minExpressions) {
    failures.push(
      `extraction floor: ${expressions.length} expressions < ${minExpressions} - extend the extractor in scripts/alert-rules-lint.mjs`,
    );
  }
  if (registered.size < minRegistered) {
    failures.push(
      `gauge floor: ${registered.size} registered names < ${minRegistered}`,
    );
  }
  if (referenced.size < minReferenced) {
    failures.push(
      `reference floor: ${referenced.size} referenced names < ${minReferenced}`,
    );
  }

  console.log(
    `alert-rules-lint: ${expressions.length} PromQL expressions parsed, ` +
      `${referenced.size} referenced metric names checked against ${registered.size} registered gauges, peg policy validated`,
  );

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} failure(s):\n${failures
        .map((failure) => `  - ${failure}`)
        .join("\n")}`,
    );
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
