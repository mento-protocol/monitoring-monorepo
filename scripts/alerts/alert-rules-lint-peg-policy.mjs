/**
 * Peg policy half of the alert-rules linter.
 *
 * Two checks live here. The bundle check reads alerts/rules/peg-thresholds.json
 * and holds it to a strict shape: exact key sets, per-field numeric bands, the
 * threshold relationships between warn and critical, and exact agreement with
 * the metrics-bridge service registry. The PromQL check reads the expressions
 * the extractor found and proves every mento_peg_* selector is bound to the
 * policy version its rule is scoped to, so a rollover cannot leave a rule
 * reading the wrong policy plane.
 *
 * ADR 0044 owns the gated rules plane these rules implement.
 */
import {
  POLICY_VERSION_DIGEST_PATTERN,
  pegPolicyVersionDigest,
} from "../lib/peg-policy-digest.mjs";

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
const MAX_POLICY_ASSETS = 32;
const MAX_POLICY_SOURCES = 16;
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
  return source.listingAbsentConsecutiveChecks;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function validatePolicySource(source, registrySource, location, failures) {
  if (!validateExactObject(source, POLICY_SOURCE_KEYS, location, failures)) {
    return;
  }
  validateNumberFields(source, location, SOURCE_NUMBER_RULES, failures);

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
  // Before a rollover, previous-policy templates are dormant and there is no
  // literal previous version to compare. Keep validating their selector shape
  // so a later JSON-only rollover cannot activate a wildcard, negative, or
  // unscoped matcher that was accepted while previous=null.
  if (typeof expectedVersion !== "string") return false;
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
    const expectedDescription =
      typeof expectedVersion === "string"
        ? `${policySlot} version ${expectedVersion}`
        : `${policySlot} policy local ${APPROVED_POLICY_VERSION_INTERPOLATION[policySlot]}`;
    failures.push(
      `${location}: ${metric} policy_version matcher must equal ${expectedDescription}`,
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
  if (
    scope.policy === "previous" &&
    selectors.some(({ metric }) => metric === "mento_peg_policy_version")
  ) {
    failures.push(
      `${location}: previous decision rules must not depend on mento_peg_policy_version; retained rules end only through reviewed policy cleanup`,
    );
  }
  // Previous-policy templates must exist before a rollover so a JSON-only
  // policy change can instantiate the full retained rule set. Even while
  // previous=null keeps those templates dormant, each selector must use exact
  // equality to the reserved previous-policy local.
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

/** The active/previous version pair the PromQL check binds selectors to. */
export function pegPolicyVersions(bundle) {
  return {
    active: isObject(bundle?.active) ? bundle.active.version : "",
    previous: isObject(bundle?.previous) ? bundle.previous.version : null,
  };
}
