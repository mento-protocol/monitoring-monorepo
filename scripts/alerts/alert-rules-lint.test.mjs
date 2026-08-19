#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractExpressions,
  lintPromql,
  neutralize,
  pegPolicyVersionDigest,
  referencedMetricNames,
  registeredMetricNames,
  stripComments,
  unescapeHcl,
  validatePegPolicyBundle,
  validatePegPromqlExpressions,
} from "./alert-rules-lint.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.resolve(__dirname, "alert-rules-lint.mjs");
const pegPolicyFixture = JSON.parse(
  readFileSync(
    path.resolve(repoRoot, "alerts/rules/peg-thresholds.json"),
    "utf8",
  ),
);
const pegRegistryFixture = JSON.parse(
  readFileSync(
    path.resolve(repoRoot, "metrics-bridge/peg-registry.json"),
    "utf8",
  ),
);

let passed = 0;
let failed = 0;

function fail(name, message) {
  failed += 1;
  process.stderr.write(`FAIL ${name}\n  ${message}\n`);
}

function pass(name) {
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractBlockAt(source, startIndex) {
  const openBrace = source.indexOf("{", startIndex);
  assert(openBrace >= 0, "block opening brace not found");

  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(startIndex, i + 1);
  }
  throw new Error("block closing brace not found");
}

function blocksFor(source, marker) {
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const markerIndex = source.indexOf(marker, searchFrom);
    if (markerIndex === -1) return blocks;
    blocks.push(extractBlockAt(source, markerIndex));
    searchFrom = markerIndex + marker.length;
  }
}

function test(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

function runCli(options = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

test("neutralize Terraform format verbs and interpolations", () => {
  assert(
    neutralize("floor(((%s) %% 86400) / 3600)") ===
      "floor(((placeholder_metric) % 86400) / 3600)",
    "expected %% to become a literal PromQL modulo operator",
  );
  assert(
    neutralize("${local.a} >= ${local.b}") ===
      "placeholder_metric >= placeholder_metric",
    "expected Terraform interpolations to become placeholder selectors",
  );
});

test("unescapeHcl removes escaped HCL quotes", () => {
  assert(
    unescapeHcl('sum(x{s=\\"error\\"})') === 'sum(x{s="error"})',
    "expected escaped quotes to be unescaped",
  );
});

test("extractExpressions covers supported HCL shapes", () => {
  const fixture = stripComments(`
locals {
  # expr = "comment_only_metric"
  ratio_promql = "up == 1"
  inline_comment_expr = "up == 1" # valid HCL inline comment
  slash_comment_expr = "sum(rate(http_requests_total{url=\\"https://example.test\\"}[5m]))" // valid HCL inline comment
  foo_regex = format("^%s$", local.foo)
  age_expr = format(
    "floor(((%s) %% 86400) / 3600)",
    local.source,
  )
  outlier_expr = <<-EOT
sum(up)
EOT
}

resource "grafana_rule_group" "fixture" {
  rule {
    data {
      model = jsonencode({
        expr = "mento_pool_limit_pressure"
      })
    }
    data {
      model = jsonencode({
        expr = join(" and ", [
          "up == 1",
          "mento_cdp_shutdown",
        ])
      })
    }
    data {
      model = jsonencode({
        expr = format(
          "%s unless (%s)",
          join(" and ", [
            "last_over_time(mento_pool_rebalance_effectiveness[1h])",
            "mento_pool_limit_pressure",
          ]),
          local.window,
        )
      })
    }
  }
}
`);
  const expressions = extractExpressions("fixture.tf", fixture);
  assert(
    expressions.length === 13,
    `expected 13 expressions, got ${expressions.length}: ${JSON.stringify(expressions)}`,
  );
  assert(
    expressions.some((entry) => entry.expr === "up == 1"),
    "expected single-line expression with inline HCL comment",
  );
  assert(
    expressions.some((entry) =>
      entry.expr.includes('url="https://example.test"'),
    ),
    "expected // inside a quoted string to be preserved",
  );
  assert(
    expressions.some(
      (entry) =>
        entry.kind === "format" &&
        entry.expr === "floor(((%s) %% 86400) / 3600)",
    ),
    "expected multiline format() expression",
  );
  assert(
    !expressions.some((entry) => entry.expr.includes("^%s$")),
    "foo_regex format local should not be extracted",
  );
  assert(
    !expressions.some((entry) => entry.expr === "comment_only_metric"),
    "full-line comments should not be extracted",
  );
  assert(
    expressions.some(
      (entry) =>
        entry.kind === "join-elem" &&
        entry.expr === "last_over_time(mento_pool_rebalance_effectiveness[1h])",
    ),
    "expected format-wrapped join fragment with a range selector",
  );
  assert(
    expressions.some(
      (entry) =>
        entry.kind === "join" &&
        entry.expr ===
          "last_over_time(mento_pool_rebalance_effectiveness[1h]) and mento_pool_limit_pressure",
    ),
    "expected full joined PromQL expression",
  );
});

test("extractExpressions binds reserved peg locals to rollover scope", () => {
  const fixture = stripComments(`
locals {
  peg_active_deviation_promql = "mento_peg_deviation_bps{policy_version=\\"\${local.peg_active_policy_version}\\"} > 25"
  peg_previous_deviation_expr = <<-EOT
mento_peg_deviation_bps{policy_version="\${local.peg_previous_policy_version}"} > 25
EOT
  peg_rollover_ack_health_expr = format(
    "absent(mento_peg_policy_version{policy_version=\\"\${local.peg_active_policy_version}\\"})",
  )
  peg_active_health_promql = join(" and ", [
    "mento_peg_blind{policy_version=\\"\${local.peg_active_policy_version}\\"} == 0",
    "mento_peg_source_healthy{policy_version=\\"\${local.peg_active_policy_version}\\"} == 1",
  ])
}
`);
  const expressions = extractExpressions("rules-peg.tf", fixture).filter(
    ({ expr }) => expr.includes("mento_peg_"),
  );

  assert(
    expressions.length === 6,
    `expected six scoped peg expressions, got ${JSON.stringify(expressions)}`,
  );
  assert(
    expressions.some(
      ({ pegRule }) =>
        pegRule?.kind === "decision" && pegRule.policy === "active",
    ),
    "expected an active decision scope",
  );
  assert(
    expressions.some(
      ({ pegRule }) =>
        pegRule?.kind === "decision" && pegRule.policy === "previous",
    ),
    "expected a previous decision scope",
  );
  assert(
    expressions.some(({ pegRule }) => pegRule?.kind === "rollover-ack"),
    "expected a rollover-ack scope",
  );
  const failures = validatePegPromqlExpressions(expressions, {
    active: "europ-v2",
    previous: "europ-v1",
  });
  assert(
    failures.length === 0,
    `expected extracted rollover scopes to validate: ${failures.join("\n")}`,
  );
});

test("extractExpressions parses scoped map-comprehension format templates", () => {
  const fixture = stripComments(`
locals {
  peg_active_deviation_promql = {
    for source_id, source in local.sources : source_id => format(
      "mento_peg_deviation_bps > %g",
      source.threshold,
    )
  }
}
`);
  const [expression] = extractExpressions("rules-peg.tf", fixture);
  assert(expression !== undefined, "expected map format expression");
  assert(
    expression.kind === "map-format" &&
      expression.pegRule?.kind === "decision" &&
      expression.pegRule.policy === "active",
    `expected active map scope, got ${JSON.stringify(expression)}`,
  );
  assert(
    lintPromql(neutralize(expression.expr)) === null,
    `expected extracted map expression to parse: ${expression.expr}`,
  );
});

test("extractExpressions parses rendered join() syntax", () => {
  const fixture = stripComments(`
data {
  model = jsonencode({
    expr = join(" ;; ", [
      "up == 1",
      "up == 0",
    ])
  })
}
`);
  const joined = extractExpressions("bad-join.tf", fixture).find(
    (entry) => entry.kind === "join",
  );
  assert(joined !== undefined, "expected joined PromQL expression");
  assert(
    lintPromql(neutralize(joined.expr)) !== null,
    `expected invalid join separator to fail parsing, got: ${joined.expr}`,
  );
});

test("lintPromql returns null for valid expressions and a message for invalid ones", () => {
  assert(lintPromql("up == 1") === null, "expected valid PromQL to pass");
  assert(
    lintPromql("sum(rate(mento_pool_oracle_ok[5m])") !== null,
    "expected unbalanced PromQL to fail",
  );
});

test("metric name helpers extract registered and referenced names", () => {
  const registered = registeredMetricNames(`
    { name: "mento_pool_oracle_ok" },
    { name: "mento_cdp_shutdown" },
    { name: "mento_peg_deviation_bps" },
    { name: "not_a_mento_metric" },
  `);
  assert(
    JSON.stringify(registered) ===
      JSON.stringify([
        "mento_pool_oracle_ok",
        "mento_cdp_shutdown",
        "mento_peg_deviation_bps",
      ]),
    `unexpected registered names: ${JSON.stringify(registered)}`,
  );

  const referenced = referencedMetricNames(`
    expr = "mento_pool_oracle_ok + mento_cdp_shutdown + mento_peg_deviation_bps + mento_other_ignored"
  `);
  assert(
    JSON.stringify(referenced) ===
      JSON.stringify([
        "mento_pool_oracle_ok",
        "mento_cdp_shutdown",
        "mento_peg_deviation_bps",
      ]),
    `unexpected referenced names: ${JSON.stringify(referenced)}`,
  );
});

function freshPegPolicy() {
  return structuredClone(pegPolicyFixture);
}

function sealPolicyVersion(policyVersion, prefix) {
  policyVersion.version = `${prefix}-${pegPolicyVersionDigest(policyVersion)}`;
}

function pegPolicyFailures(policy) {
  return validatePegPolicyBundle(policy, pegRegistryFixture).join("\n");
}

test("committed peg policy is strict and matches the registry", () => {
  const failures = validatePegPolicyBundle(
    pegPolicyFixture,
    pegRegistryFixture,
  );
  assert(
    failures.length === 0,
    `expected committed policy to pass:\n${failures.join("\n")}`,
  );
});

test("peg policy requires distinct complete active and previous versions", () => {
  const validRollover = freshPegPolicy();
  validRollover.previous = structuredClone(validRollover.active);
  sealPolicyVersion(validRollover.previous, "europ-v0");
  assert(
    validatePegPolicyBundle(validRollover, pegRegistryFixture).length === 0,
    "expected a complete distinct previous policy to pass",
  );

  const duplicate = structuredClone(validRollover);
  duplicate.previous.version = duplicate.active.version;
  assert(
    /must differ from active\.version/.test(pegPolicyFailures(duplicate)),
    "expected duplicate rollover versions to fail",
  );

  const incomplete = structuredClone(validRollover);
  delete incomplete.previous.assets;
  assert(
    /peg policy\.previous: missing assets/.test(pegPolicyFailures(incomplete)),
    "expected incomplete previous policy to fail",
  );
});

test("peg policy rejects unknown fields and source-id drift", () => {
  const policy = freshPegPolicy();
  const asset = policy.active.assets["europ-schuman"];
  asset.unreviewedThreshold = 1;
  delete asset.sources.kraken_usd;
  asset.sources.kraken_typo = structuredClone(asset.sources.kraken_eur);

  const failures = pegPolicyFailures(policy);
  assert(
    /unknown field unreviewedThreshold/.test(failures),
    "expected strict asset fields",
  );
  assert(/missing kraken_usd/.test(failures), "expected missing source id");
  assert(
    /unknown field kraken_typo/.test(failures),
    "expected extra source id",
  );
});

test("peg policy requires exactly one registry-aligned deep venue", () => {
  const policy = freshPegPolicy();
  const asset = policy.active.assets["europ-schuman"];
  asset.sources.kraken_eur.authority = "deep";
  asset.deepVenueSource = "kraken_eur";

  const failures = pegPolicyFailures(policy);
  assert(
    /expected exactly one deep venue/.test(failures),
    "expected multiple deep sources to fail",
  );
  assert(
    /expected secondary for registry role secondary/.test(failures),
    "expected source authority to match registry role",
  );
});

test("peg policy requires bounded listing confirmation and matching staleness", () => {
  const policy = freshPegPolicy();
  const source = policy.active.assets["europ-schuman"].sources.bitvavo_eur;
  source.pollIntervalSeconds = 30;
  source.staleAfterSeconds = 59;
  source.listingAbsentConsecutiveChecks = 2;
  source.referenceSizeCap = 0;

  const failures = pegPolicyFailures(policy);
  assert(
    /referenceSizeCap: must be > 0/.test(failures),
    "expected positive reference-size cap",
  );
  assert(
    /staleAfterSeconds: must cover pollIntervalSeconds \* listingAbsentConsecutiveChecks/.test(
      failures,
    ),
    "expected staleness to cover listing confirmation",
  );
  source.staleAfterSeconds = 60;
  source.listingAbsentConsecutiveChecks = 1_001;
  const boundedFailures = pegPolicyFailures(policy);
  assert(
    /listingAbsentConsecutiveChecks: must be <= 1000/.test(boundedFailures),
    "expected bounded listing confirmation",
  );
});

test("peg policy requires every source to declare listing confirmation", () => {
  const policy = freshPegPolicy();
  assert(
    policy.previous === null,
    "expected the committed policy predecessor to be cleared",
  );
  assert(
    pegPolicyFailures(policy) === "",
    "expected the checked-in active policy to declare every threshold",
  );

  delete policy.active.assets["europ-schuman"].sources.bitvavo_eur
    .listingAbsentConsecutiveChecks;
  assert(
    /listingAbsentConsecutiveChecks/.test(pegPolicyFailures(policy)),
    "expected every policy source to require an explicit threshold",
  );
});

test("peg policy enforces warning, critical, and sustain ordering", () => {
  const policy = freshPegPolicy();
  const asset = policy.active.assets["europ-schuman"];
  asset.criticalDeviationBps = asset.warnDeviationBps;
  asset.criticalSustainSeconds = asset.warnSustainSeconds - 1;

  const failures = pegPolicyFailures(policy);
  assert(
    /criticalDeviationBps: must be greater than warnDeviationBps/.test(
      failures,
    ),
    "expected deviation ordering failure",
  );
  assert(
    /criticalSustainSeconds: must be >= warnSustainSeconds/.test(failures),
    "expected sustain ordering failure",
  );
});

test("peg policy bounds freshness, blindness, coverage, and structural thresholds", () => {
  const policy = freshPegPolicy();
  const asset = policy.active.assets["europ-schuman"];
  asset.freshnessGraceSeconds = 0;
  asset.blindConsecutivePolls = 1_001;
  asset.durationQuantile = 1;
  asset.minimumCoverageFraction = 1.1;
  asset.structuralWarnFraction = 0;
  asset.permanentlyDeadSeconds = 0;

  const failures = pegPolicyFailures(policy);
  for (const field of [
    "freshnessGraceSeconds",
    "blindConsecutivePolls",
    "durationQuantile",
    "minimumCoverageFraction",
    "structuralWarnFraction",
    "permanentlyDeadSeconds",
  ]) {
    assert(failures.includes(field), `expected ${field} to fail validation`);
  }
});

test("peg policy version syntax matches the runtime contract", () => {
  const policy = freshPegPolicy();
  policy.active.version = "EUROP-v1";

  assert(
    /active\.version: expected a non-empty identifier/.test(
      pegPolicyFailures(policy),
    ),
    "expected uppercase runtime-incompatible policy version to fail",
  );
});

test("peg policy version suffix binds the immutable policy content", () => {
  const missingSuffix = freshPegPolicy();
  missingSuffix.active.version = "europ-v1";
  assert(
    /must end with the first 32 lowercase hex/.test(
      pegPolicyFailures(missingSuffix),
    ),
    "expected an unhashed policy version to fail",
  );

  const mutated = freshPegPolicy();
  mutated.active.assets["europ-schuman"].warnDeviationBps += 1;
  assert(
    /digest suffix .* does not match policy content/.test(
      pegPolicyFailures(mutated),
    ),
    "expected a content mutation with a retained suffix to fail",
  );

  sealPolicyVersion(mutated.active, "europ-v2");
  assert(
    validatePegPolicyBundle(mutated, pegRegistryFixture).length === 0,
    "expected resealing the changed policy content to pass",
  );
});

test("peg policy digest uses locale-independent code-point key order", () => {
  assert(
    pegPolicyVersionDigest({
      version: "ignored",
      assets: {
        "asset-a": {
          sources: {
            kraken_eur: { weight: 1 },
            kraken2_eur: { weight: 2 },
          },
        },
      },
      rolloverAckExpectedSeconds: 300,
    }) === "366f968f8c1281f3aa1a31126dfceff7",
    "expected CI digest to use code-point ordering for digit/underscore keys",
  );
});

test("peg policy accepts complete A-to-B topology while retaining previous", () => {
  const policy = freshPegPolicy();
  const registry = structuredClone(pegRegistryFixture);
  policy.previous = structuredClone(policy.active);
  sealPolicyVersion(policy.previous, "europ-v1");

  const newRegistrySource = structuredClone(
    registry["europ-schuman"].sources.find(
      (source) => source.id === "kraken_eur",
    ),
  );
  newRegistrySource.id = "kraken_eur_backup";
  registry["europ-schuman"].sources.push(newRegistrySource);
  policy.active.assets["europ-schuman"].sources.kraken_eur_backup =
    structuredClone(policy.active.assets["europ-schuman"].sources.kraken_eur);
  sealPolicyVersion(policy.active, "europ-v2");

  const failures = validatePegPolicyBundle(policy, registry);
  assert(
    failures.length === 0,
    `expected current B topology and retained A policy to pass:\n${failures.join("\n")}`,
  );

  delete policy.active.assets["europ-schuman"].sources.kraken_eur_backup;
  sealPolicyVersion(policy.active, "europ-v3");
  assert(
    /active.*missing kraken_eur_backup/.test(
      validatePegPolicyBundle(policy, registry).join("\n"),
    ),
    "expected current active policy drift from registry B to remain fatal",
  );
});

test("peg PromQL requires every metric selector to bind policy_version", () => {
  const failures = validatePegPromqlExpressions(
    [
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'mento_peg_deviation_bps{asset="europ-schuman",policy_version="europ-v1"} > 25 and mento_peg_observation_at{asset="europ-schuman"}',
      },
    ],
    { active: "europ-v1", previous: null },
  ).join("\n");

  assert(
    /mento_peg_observation_at is missing a policy_version matcher/.test(
      failures,
    ),
    `expected unbound freshness selector to fail: ${failures}`,
  );
});

test("peg PromQL keeps no-rollover selectors exact-active", () => {
  const versions = { active: "europ-v2", previous: null };
  const exact = validatePegPromqlExpressions(
    [
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'mento_peg_deviation_bps{policy_version="europ-v2"} > 25',
      },
    ],
    versions,
  );
  assert(
    exact.length === 0,
    `expected exact active selector to pass without rollover: ${exact.join("\n")}`,
  );

  const contaminated = validatePegPromqlExpressions(
    [
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'mento_peg_deviation_bps{policy_version=~"^(?:europ-v2|europ-v1)$"} > 25',
      },
    ],
    versions,
  );
  assert(
    contaminated.some((failure) => failure.includes("must equal active")),
    "expected a no-rollover union selector to fail",
  );
});

test("peg PromQL requires rule scope during rollover", () => {
  const failures = validatePegPromqlExpressions(
    [
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'mento_peg_deviation_bps{policy_version="europ-v2"} > 25',
      },
    ],
    { active: "europ-v2", previous: "europ-v1" },
  );
  assert(
    failures.some((failure) => failure.includes("must declare pegRule")),
    `expected unscoped rollover decision to fail: ${failures.join("\n")}`,
  );
});

test("peg PromQL decision rules bind their exact policy version", () => {
  const expression = (policy, matcher) => [
    {
      file: "rules-peg.tf",
      kind: "single",
      expr: `mento_peg_deviation_bps{policy_version${matcher}} > 25`,
      pegRule: { kind: "decision", policy },
    },
  ];
  const versions = { active: "europ-v2", previous: "europ-v1" };

  for (const [policy, matcher] of [
    ["active", '="europ-v1"'],
    ["active", '=~"^(?:europ-v2|europ-v1)$"'],
    ["previous", '="europ-v2"'],
    ["previous", '=~"^(?:europ-v2|europ-v1)$"'],
  ]) {
    const failures = validatePegPromqlExpressions(
      expression(policy, matcher),
      versions,
    );
    assert(
      failures.some((failure) =>
        failure.includes(`must equal ${policy} version`),
      ),
      `expected ${policy} ${matcher} to reject cross-version or union contamination`,
    );
  }

  const exact = [
    ...expression("active", '="europ-v2"'),
    ...expression("previous", '="europ-v1"'),
  ];
  const failures = validatePegPromqlExpressions(exact, versions);
  assert(
    failures.length === 0,
    `expected exact active and previous decisions to pass: ${failures.join("\n")}`,
  );
});

test("peg PromQL rejects unrelated interpolation and negative narrowing", () => {
  const expressions = (expr) => [
    {
      file: "rules-peg.tf",
      kind: "single",
      expr,
      pegRule: { kind: "decision", policy: "active" },
    },
  ];
  const versions = { active: "europ-v2", previous: "europ-v1" };

  const unrelated = validatePegPromqlExpressions(
    expressions(
      'mento_peg_deviation_bps{policy_version=~"${local.unrelated_regex}"} > 25',
    ),
    versions,
  );
  assert(
    unrelated.some((failure) => failure.includes("must equal active")),
    `expected unrelated interpolation to fail: ${unrelated.join("\n")}`,
  );

  const narrowed = validatePegPromqlExpressions(
    expressions(
      'mento_peg_deviation_bps{policy_version=~"^(?:europ-v2|europ-v1)$",policy_version!="europ-v2"} > 25',
    ),
    versions,
  );
  assert(
    narrowed.some((failure) => failure.includes("exactly one positive")),
    `expected negative narrowing to fail: ${narrowed.join("\n")}`,
  );
});

test("peg PromQL accepts only the approved policy-derived interpolation", () => {
  const failures = validatePegPromqlExpressions(
    [
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'mento_peg_deviation_bps{policy_version="${local.peg_active_policy_version}"} > 25',
        pegRule: { kind: "decision", policy: "active" },
      },
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'mento_peg_deviation_bps{policy_version="${local.peg_previous_policy_version}"} > 25',
        pegRule: { kind: "decision", policy: "previous" },
      },
    ],
    { active: "europ-v2", previous: "europ-v1" },
  );
  assert(
    failures.length === 0,
    `expected approved policy interpolation to pass: ${failures.join("\n")}`,
  );

  const swapped = validatePegPromqlExpressions(
    [
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'mento_peg_deviation_bps{policy_version="${local.peg_previous_policy_version}"} > 25',
        pegRule: { kind: "decision", policy: "active" },
      },
    ],
    { active: "europ-v2", previous: "europ-v1" },
  );
  assert(
    swapped.some((failure) => failure.includes("must equal active")),
    "expected a policy-slot interpolation used by the wrong rule to fail",
  );
});

test("peg PromQL requires exact dormant previous selectors before rollover", () => {
  const dormantPrevious = (expr) => [
    {
      file: "rules-peg.tf",
      kind: "format",
      expr,
      pegRule: { kind: "decision", policy: "previous" },
    },
  ];
  const versions = { active: "europ-v2", previous: null };
  const failures = validatePegPromqlExpressions(
    dormantPrevious(
      'mento_peg_deviation_bps{policy_version="${local.peg_previous_policy_version}"} > 25',
    ),
    versions,
  );
  assert(
    failures.length === 0,
    `expected dormant previous template to pass: ${failures.join("\n")}`,
  );

  for (const [name, expr, expectedFailure] of [
    [
      "missing selector",
      "mento_peg_deviation_bps > 25",
      "missing a policy_version selector",
    ],
    [
      "missing matcher",
      'mento_peg_deviation_bps{asset="europ"} > 25',
      "missing a policy_version matcher",
    ],
    [
      "negative matcher",
      'mento_peg_deviation_bps{policy_version!="${local.peg_previous_policy_version}"} > 25',
      "negative matcher",
    ],
    [
      "wildcard matcher",
      'mento_peg_deviation_bps{policy_version=~".*"} > 25',
      "must equal previous policy local",
    ],
    [
      "regex local matcher",
      'mento_peg_deviation_bps{policy_version=~"${local.peg_previous_policy_version}"} > 25',
      "must equal previous policy local",
    ],
    [
      "literal matcher",
      'mento_peg_deviation_bps{policy_version="europ-v1"} > 25',
      "must equal previous policy local",
    ],
  ]) {
    const rejected = validatePegPromqlExpressions(
      dormantPrevious(expr),
      versions,
    );
    assert(
      rejected.some((failure) => failure.includes(expectedFailure)),
      `expected dormant previous ${name} to fail: ${rejected.join("\n")}`,
    );
  }
});

test("committed peg rules preserve coverage, rollover, and routing invariants", () => {
  const ruleDefinitions = readFileSync(
    path.resolve(repoRoot, "alerts/rules/peg-rule-definitions.tf"),
    "utf8",
  );
  const source = [
    "peg-policy-locals.tf",
    "peg-promql-active.tf",
    "peg-promql-previous.tf",
    "peg-rule-definitions.tf",
    "rules-peg.tf",
  ]
    .map((file) =>
      readFileSync(path.resolve(repoRoot, "alerts/rules", file), "utf8"),
    )
    .join("\n");
  const contacts = readFileSync(
    path.resolve(repoRoot, "alerts/rules/peg-contact-points.tf"),
    "utf8",
  );
  const templates = readFileSync(
    path.resolve(repoRoot, "alerts/rules/peg-message-templates.tf"),
    "utf8",
  );
  const europPolicies = [pegPolicyFixture.active.assets["europ-schuman"]];

  assert(
    source.includes("increase(mento_peg_poll_success_total") &&
      source.includes("increase(mento_peg_usable_decision_total") &&
      source.includes("ceil(item.asset.warnSustainSeconds") &&
      source.includes("ceil(item.asset.criticalSustainSeconds") &&
      !source.includes("count_over_time(mento_peg_deviation_bps") &&
      !source.includes("count_over_time(mento_peg_source_healthy"),
    "duration rules must require both counters at a whole-decision coverage floor",
  );
  assert(
    source.includes("== bool 0 or absent(mento_peg_source_healthy") &&
      source.includes(
        "item.asset.criticalDeviationBps + item.source.conversionErrorBps",
      ) &&
      source.includes(
        "item.asset.premiumWarnBps + item.source.conversionErrorBps",
      ),
    "health comparisons and conversion error bands must stay explicit",
  );
  for (const policy of ["active", "previous"]) {
    assert(
      source.includes(`peg_${policy}_authoritative_sources = {`) &&
        source.includes(
          `peg_${policy}_operational_sources = local.peg_${policy}_authoritative_sources`,
        ) &&
        source.includes(`peg_${policy}_secondary_sources = {`) &&
        source.includes(`peg_${policy}_source_unhealthy_for_duration = {`) &&
        source.includes(
          'peg_secondary_source_unhealthy_for_duration = "1800s"',
        ) &&
        source.includes('item.source.authority != "display"') &&
        source.includes(
          'item.source.authority == "secondary" ? local.peg_secondary_source_unhealthy_for_duration',
        ) &&
        ruleDefinitions.includes(
          `for key, item in local.peg_${policy}_operational_sources : "${policy}-unhealthy-\${key}" => {`,
        ) &&
        ruleDefinitions.includes(
          `for key, item in local.peg_${policy}_secondary_sources : "${policy}-dead-\${key}" => {`,
        ) &&
        ruleDefinitions.includes(
          `for_duration       = local.peg_${policy}_source_unhealthy_for_duration[key]`,
        ) &&
        !ruleDefinitions.includes(
          `for key, item in local.peg_${policy}_sources : "${policy}-unhealthy-\${key}" => {`,
        ) &&
        !ruleDefinitions.includes(
          `for key, item in local.peg_${policy}_non_deep_sources : "${policy}-dead-\${key}" => {`,
        ),
      `${policy} source-health rules must skip display sources, hold secondary failures for 30 minutes, and retain deep two-poll duration`,
    );
  }
  for (const policy of ["active", "previous"]) {
    const policyVersion = `\${local.peg_${policy}_policy_version}`;
    const sourceUnhealthy =
      `(mento_peg_source_healthy{asset=\\"%s\\",source=\\"%s\\",policy_version=\\"${policyVersion}\\"} == bool 0 ` +
      `or absent(mento_peg_source_healthy{asset=\\"%s\\",source=\\"%s\\",policy_version=\\"${policyVersion}\\"})) ` +
      `and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\\"%s\\",policy_version=\\"${policyVersion}\\"} <= %d)`;
    assert(
      source.includes(sourceUnhealthy),
      `${policy} source health must fail closed for an absent exact source while the exact asset heartbeat is fresh`,
    );

    const failures = validatePegPromqlExpressions(
      [
        {
          file: `peg-promql-${policy}.tf`,
          kind: "format",
          expr: sourceUnhealthy.replaceAll('\\"', '"'),
          pegRule: { kind: "decision", policy },
        },
      ],
      { active: "europ-v2", previous: "europ-v1" },
    );
    assert(
      failures.length === 0,
      `${policy} absent source-health fallback must retain exact policy scoping: ${failures.join("\\n")}`,
    );
  }
  assert(
    source.includes(
      'mento_peg_blind_consecutive_polls{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"} >= bool %d and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"} <= %d)',
    ) &&
      source.includes(
        'mento_peg_blind_consecutive_polls{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"} >= %d and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"} <= %d)',
      ) &&
      source.includes("asset.blindConsecutivePolls") &&
      !source.includes(
        "blindConsecutivePolls * asset.sources[asset.deepVenueSource].pollIntervalSeconds",
      ) &&
      source.includes(
        'max_over_time(mento_peg_last_poll{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"}[%ds]) > bool %d',
      ) &&
      source.includes(
        'max_over_time(mento_peg_last_poll{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"}[%ds]) > bool %d',
      ),
    "active blindness must retain a healthy false series with bool while missing or stale inputs remain NoData, and previous policy semantics stay unchanged",
  );
  assert(
    source.includes(
      'mento_peg_blind_consecutive_polls{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"} >= %d and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"} <= %d) and on(asset,policy_version) ((mento_peg_structural_saturation{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"} >= %g and on(asset,policy_version) mento_peg_indexed_pool_reachable{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"} == 1) or (mento_peg_spread_bps',
    ) &&
      source.includes(
        'mento_peg_blind_consecutive_polls{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"} >= %d and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"} <= %d) and on(asset,policy_version) ((mento_peg_structural_saturation{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"} >= %g and on(asset,policy_version) mento_peg_indexed_pool_reachable{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"} == 1) or (mento_peg_spread_bps',
      ) &&
      !source.includes("mento_peg_blind{"),
    "blind-while-stressed must gate only structural saturation on pool reachability so market stress remains independently page-capable",
  );
  assert(
    source.includes("mento_peg_filled_fraction") &&
      (source.match(/\} \* 100 or on\(\) vector\(-1\)/g) ?? []).length === 4 &&
      !source.includes("(mul $values.Fill.Value") &&
      !source.includes("(mul $values.Structural.Value"),
    "annotation percentages must be scaled in PromQL because Grafana annotation templates do not expose Sprig math",
  );
  assert(
    source.includes(
      'name               = "Peg Blind Warning [${asset_id} · active]"',
    ) &&
      /active-blind-\$\{asset_id\}[\s\S]{0,400}no_data_state\s+=\s+"Alerting"/.test(
        source,
      ) &&
      /active-blind-stressed-\$\{asset_id\}[\s\S]{0,400}no_data_state\s+=\s+"OK"/.test(
        source,
      ) &&
      /previous-blind-\$\{asset_id\}[\s\S]{0,400}no_data_state\s+=\s+"OK"/.test(
        source,
      ),
    "only active blind producer absence should fail closed through NoData",
  );
  assert(
    source.includes(
      "peg_rollover_rule_definitions = local.peg_previous_policy == null ? {} : {",
    ),
    "rollover-stuck rule must exist only while a previous policy is retained",
  );
  assert(
    !/peg_previous_[a-z0-9_]+_(?:promql|expr)[\s\S]{0,300}unless\s+mento_peg_policy_version/.test(
      source,
    ),
    "previous decisions must not stop at the first active-policy ACK",
  );
  assert(
    source.includes("for_each = local.peg_rule_definitions") &&
      source.includes('name             = "Peg Monitoring"') &&
      source.includes("notification_settings {") &&
      source.includes("grafana_contact_point.peg_market_warning") &&
      source.includes("grafana_contact_point.peg_ops_warning") &&
      source.includes("grafana_contact_point.peg_page") &&
      contacts.includes("peg_contact_point_names = {") &&
      contacts.includes("name = local.peg_contact_point_names.page") &&
      contacts.includes(
        'page = "Peg pages (Splunk On-Call + #alerts-critical)"',
      ) &&
      contacts.includes(
        "contact_point   = local.peg_contact_point_names.page",
      ) &&
      contacts.includes("victorops {") &&
      contacts.includes("var.slack_channel_critical") &&
      contacts.includes(
        '["alertname", "grafana_folder", "asset", "source", "policy_version"]',
      ) &&
      templates.includes('{{ define "peg.slack.title"') &&
      templates.includes('{{ define "peg.slack.message"') &&
      templates.includes('{{ define "peg.victorops.title"') &&
      templates.includes('{{ define "peg.victorops.message"') &&
      templates.includes("range .Alerts.Firing") &&
      templates.includes("range .Alerts.Resolved") &&
      templates.includes("EXECUTABLE PRICE:") &&
      templates.includes("DOWNSIDE DEVIATION:") &&
      templates.includes("EXECUTABLE FILL:") &&
      templates.includes("SPREAD:") &&
      templates.includes("STRUCTURAL SATURATION:") &&
      source.includes('ref_id         = "Spread"') &&
      source.includes(
        "try(coalesce(rule.value.spread_expr, local.peg_empty_context_promql), local.peg_empty_context_promql)",
      ) &&
      contacts.includes("grafana_message_template.peg_victorops_message"),
    "peg rules must route a complete decision package with a safe spread fallback for absent or null expressions",
  );
  assert(
    !source.includes("mute_timing") && !contacts.includes("mute_timing"),
    "peg decisions must not inherit the FX weekend mute",
  );
  assert(
    source.includes(
      'mento_peg_listing_state{asset=\\"%s\\",source=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\",state=\\"absent\\"} == 1',
    ) &&
      source.includes(
        'mento_peg_listing_absent_consecutive_checks{asset=\\"%s\\",source=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"} >= %d',
      ) &&
      source.includes(
        'mento_peg_listing_state{asset=\\"%s\\",source=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\",state=\\"absent\\"} == 1',
      ) &&
      source.includes(
        'mento_peg_listing_absent_consecutive_checks{asset=\\"%s\\",source=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"} >= %d',
      ) &&
      source.includes("time() - mento_peg_listing_checked_at") &&
      !source.includes("changes(mento_peg_listing") &&
      !source.includes("min_over_time(mento_peg_listing") &&
      !source.includes("count_over_time(mento_peg_listing"),
    "listing alerts must use instant exact-version producer state, bounded streak, and fresh authoritative check time",
  );
  assert(
    !source.includes(
      "peg_legacy_listing_absent_consecutive_checks_policy_version",
    ) &&
      !source.includes("source.listingAbsentConsecutiveChecks,") &&
      source.includes(
        "listing_absent_consecutive_checks = source.listingAbsentConsecutiveChecks",
      ),
    "listing confirmation must come directly from each active or retained policy source",
  );
  assert(
    source.includes(
      'for key, item in local.peg_active_non_deep_sources : "active-registry-rot-${key}"',
    ) &&
      source.includes(
        'for key, item in local.peg_previous_non_deep_sources : "previous-registry-rot-${key}"',
      ) &&
      source.includes(
        'for key, item in local.peg_active_deep_sources : "active-critical-path-unreachable-${key}"',
      ) &&
      source.includes(
        'for key, item in local.peg_previous_deep_sources : "previous-critical-path-unreachable-${key}"',
      ) &&
      europPolicies.every(
        (asset) =>
          asset.deepVenueSource === "bitvavo_eur" &&
          asset.sources.bitvavo_eur.authority === "deep" &&
          asset.sources.kraken_eur.authority === "secondary" &&
          asset.sources.kraken_usd.authority === "display",
      ),
    "registry rot must cover all non-deep sources including display while critical-path loss stays deep-only",
  );
  for (const rulePrefix of [
    "active-registry-rot",
    "previous-registry-rot",
    "active-critical-path-unreachable",
    "previous-critical-path-unreachable",
    "active-indexed-pool-unreachable",
    "previous-indexed-pool-unreachable",
  ]) {
    const ruleStart = ruleDefinitions.indexOf(rulePrefix);
    assert(ruleStart >= 0, `expected ${rulePrefix} definition`);
    const mapStart = ruleDefinitions.lastIndexOf("\n    {", ruleStart);
    assert(mapStart >= 0, `expected ${rulePrefix} map block`);
    const ruleBlock = extractBlockAt(ruleDefinitions, mapStart);
    assert(
      /for_duration\s+=\s+"0s"/.test(ruleBlock) &&
        /no_data_state\s+=\s+"OK"/.test(ruleBlock) &&
        /severity\s+=\s+"warning"/.test(ruleBlock) &&
        /route\s+=\s+"ops"/.test(ruleBlock) &&
        /notification\s+=\s+local\.peg_notify_ops_warning/.test(ruleBlock) &&
        !ruleBlock.includes("local.peg_notify_page"),
      `${rulePrefix} must be an immediate no-data-safe ops warning and never page`,
    );
  }
  assert(
    source.includes(
      '(mento_peg_indexed_pool_reachable{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"} == bool 0 or absent(mento_peg_indexed_pool_reachable{asset=\\"%s\\",policy_version=\\"${local.peg_active_policy_version}\\"})) and on(asset,policy_version) (time() - mento_peg_last_poll',
    ) &&
      source.includes(
        '(mento_peg_indexed_pool_reachable{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"} == bool 0 or absent(mento_peg_indexed_pool_reachable{asset=\\"%s\\",policy_version=\\"${local.peg_previous_policy_version}\\"})) and on(asset,policy_version) (time() - mento_peg_last_poll',
      ),
    "indexed-pool reachability must fail closed only while the exact-version asset heartbeat is fresh",
  );
  assert(
    source.includes('ref_id         = "ListingAge"') &&
      source.includes(
        "try(coalesce(rule.value.listing_age_expr, local.peg_empty_context_promql), local.peg_empty_context_promql)",
      ) &&
      templates.includes("LISTING STATE:") &&
      templates.includes("LISTING CHECKED:"),
    "listing messages must include state and age with an evaluable sentinel fallback",
  );
});

test("Peg Slack pages mention @support-engineer only while critical alerts are firing", () => {
  const templates = readFileSync(
    path.resolve(repoRoot, "alerts/rules/peg-message-templates.tf"),
    "utf8",
  );
  const slackMessageTemplate = templates.slice(
    templates.indexOf(
      'resource "grafana_message_template" "peg_slack_message"',
    ),
    templates.indexOf(
      'resource "grafana_message_template" "peg_victorops_title"',
    ),
  );
  const victorOpsTemplates = templates.slice(
    templates.indexOf(
      'resource "grafana_message_template" "peg_victorops_title"',
    ),
  );
  const supportMention = "<!subteam^${var.oncall_support_usergroup_id}>";
  const guardedMention = [
    '{{ if and (len .Alerts.Firing) (eq .CommonLabels.severity "critical") -}}',
    `${supportMention} Please investigate.`,
    "{{ end -}}",
  ].join("\n");

  assert(
    slackMessageTemplate.includes(guardedMention),
    "the Slack support mention must require both a firing alert and common critical severity",
  );
  assert(
    (slackMessageTemplate.match(/<!subteam\^/gu) ?? []).length === 1,
    "the Slack support usergroup must be mentioned exactly once",
  );
  assert(
    !victorOpsTemplates.includes("<!subteam^"),
    "the Slack usergroup mention must not enter Splunk On-Call payloads",
  );
});

test("Peg Grafana and Slack copy leads with the concrete cause", () => {
  const rulesDir = path.resolve(repoRoot, "alerts/rules");
  const definitions = readFileSync(
    path.join(rulesDir, "peg-rule-definitions.tf"),
    "utf8",
  );
  const copyLocals = readFileSync(
    path.join(rulesDir, "peg-copy-locals.tf"),
    "utf8",
  );
  const rules = readFileSync(path.join(rulesDir, "rules-peg.tf"), "utf8");
  const templates = readFileSync(
    path.join(rulesDir, "peg-message-templates.tf"),
    "utf8",
  );

  assert(
    definitions.includes("sell price is") &&
      definitions.includes("below peg") &&
      definitions.includes("buy and sell prices are") &&
      definitions.includes("pool flow") &&
      definitions.includes("does not list the"),
    "Peg Grafana summaries must use the approved cause-first market wording",
  );
  assert(
    copyLocals.includes("rate limit is reached") &&
      copyLocals.includes("price request returns") &&
      copyLocals.includes("price request is timing out") &&
      copyLocals.includes("cannot be reached") &&
      copyLocals.includes("returning invalid price data"),
    "Peg Grafana summaries must explain the bounded provider failure reason",
  );
  assert(
    /kesm\s*=\s*"KESm"/.test(copyLocals) &&
      /valr\s*=\s*"VALR"/.test(copyLocals),
    "Peg Grafana summaries must preserve canonical asset and provider casing",
  );
  assert(
    rules.includes("resolved_summary = rule.value.resolved_summary") &&
      rules.includes("asset_name") &&
      rules.includes("source_name"),
    "Peg rules must expose the cause-first copy and plain display names",
  );
  assert(
    templates.includes("$alert.Annotations.summary") &&
      templates.includes("$alert.Annotations.resolved_summary") &&
      !templates.includes(".CommonLabels.alertname") &&
      !templates.includes("*FIRING:") &&
      !templates.includes("*RESOLVED:"),
    "Peg Slack titles and bodies must use the cause instead of internal alert state or rule names",
  );
});

test("Peg support-engineer input remains managed when the on-call announcer is disabled", () => {
  const infra = readFileSync(
    path.resolve(repoRoot, "alerts/infra/main.tf"),
    "utf8",
  );
  const sharedSecrets = infra.slice(
    infra.indexOf("alerts_infra_ci_shared_secret_names"),
    infra.indexOf("alerts_infra_ci_oncall_secret_names"),
  );
  const oncallSecrets = infra.slice(
    infra.indexOf("alerts_infra_ci_oncall_secret_names"),
    infra.indexOf("alerts_infra_ci_monitoring_secret_names"),
  );
  const infraVariables = readFileSync(
    path.resolve(repoRoot, "alerts/infra/variables.tf"),
    "utf8",
  );
  const supportUsergroupVariable = infraVariables.slice(
    infraVariables.indexOf('variable "oncall_support_usergroup_id"'),
    infraVariables.indexOf('variable "slack_notification_channel_id"'),
  );

  assert(
    sharedSecrets.includes('"TF_VAR_ONCALL_SUPPORT_USERGROUP_ID"'),
    "the support-engineer usergroup must be in the unconditional shared-secret set",
  );
  assert(
    !oncallSecrets.includes('"TF_VAR_ONCALL_SUPPORT_USERGROUP_ID"'),
    "the optional announcer secret set must not own the shared support-engineer usergroup",
  );
  assert(
    infra.includes("local.alerts_infra_ci_shared_secret_names,"),
    "the managed-secret union must include the shared support-engineer usergroup",
  );
  assert(
    !supportUsergroupVariable.includes('default     = ""') &&
      supportUsergroupVariable.includes('can(regex("^S[A-Z0-9]{8,}$"'),
    "the shared support-engineer usergroup must remain a required valid Slack ID",
  );
});

test("Peg Grafana consumers use a literal source activation guard", () => {
  const rulesDir = path.resolve(repoRoot, "alerts/rules");
  const policyLocals = readFileSync(
    path.join(rulesDir, "peg-policy-locals.tf"),
    "utf8",
  );
  const guardedResources = [
    ["main.tf", 'resource "grafana_folder" "peg_monitoring"'],
    [
      "peg-message-templates.tf",
      'resource "grafana_message_template" "peg_slack_title"',
    ],
    [
      "peg-message-templates.tf",
      'resource "grafana_message_template" "peg_slack_message"',
    ],
    [
      "peg-message-templates.tf",
      'resource "grafana_message_template" "peg_victorops_title"',
    ],
    [
      "peg-message-templates.tf",
      'resource "grafana_message_template" "peg_victorops_message"',
    ],
    [
      "peg-contact-points.tf",
      'resource "grafana_contact_point" "peg_market_warning"',
    ],
    [
      "peg-contact-points.tf",
      'resource "grafana_contact_point" "peg_ops_warning"',
    ],
    ["peg-contact-points.tf", 'resource "grafana_contact_point" "peg_page"'],
    ["rules-peg.tf", 'resource "grafana_rule_group" "peg_monitoring"'],
  ];
  const sourceForFile = (file) =>
    readFileSync(path.join(rulesDir, file), "utf8");
  const definitions = readFileSync(
    path.join(rulesDir, "peg-rule-definitions.tf"),
    "utf8",
  );
  const assertLiteralActivation = (source) => {
    assert(
      /\bpeg_alerts_enabled\s*=\s*(?:true|false)\b/.test(source),
      "peg alert activation must be a literal true or false in source-controlled Terraform",
    );
  };
  const assertGuardedResource = (file, marker, source) => {
    const blocks = blocksFor(source, marker);
    assert(
      blocks.length === 1,
      `expected one ${marker} block in ${file}, found ${blocks.length}`,
    );
    assert(
      /\bfor_each\s*=\s*local\.peg_alert_instances\b/.test(blocks[0]),
      `${marker} in ${file} must use the shared Peg activation map`,
    );
  };
  const expectFailure = (mutation, message) => {
    try {
      mutation();
    } catch {
      return;
    }
    throw new Error(message);
  };

  assertLiteralActivation(policyLocals);
  assert(
    /peg_alert_instances\s*=\s*local\.peg_alerts_enabled\s*\?\s*\{\s*"peg-monitoring"\s*=\s*true\s*\}\s*:\s*\{\}/s.test(
      policyLocals,
    ),
    "peg alert instances must be one stable singleton map derived from the literal source switch",
  );
  assert(
    guardedResources.length === 9,
    `expected exactly nine Peg Grafana consumers, found ${guardedResources.length}`,
  );
  for (const [file, marker] of guardedResources) {
    assertGuardedResource(file, marker, sourceForFile(file));
  }
  assert(
    /peg_rule_definitions\s*=\s*merge\([\s\S]*?local\.peg_active_rule_definitions,[\s\S]*?local\.peg_previous_rule_definitions,[\s\S]*?local\.peg_rollover_rule_definitions,[\s\S]*?\)/.test(
      definitions,
    ) && !definitions.includes("tomap("),
    "Peg rule definitions must preserve their heterogeneous object shape before activation",
  );
  expectFailure(
    () =>
      assertLiteralActivation(
        policyLocals.replace(
          /\bpeg_alerts_enabled\s*=\s*(?:true|false)\b/,
          "peg_alerts_enabled = var.peg_alerts_enabled",
        ),
      ),
    "activation guard test must reject variable-controlled activation",
  );
  expectFailure(
    () =>
      assertGuardedResource(
        "rules-peg.tf",
        'resource "grafana_rule_group" "peg_monitoring"',
        sourceForFile("rules-peg.tf").replace(
          "for_each = local.peg_alert_instances",
          "# for_each intentionally removed",
        ),
      ),
    "activation guard test must reject an unguarded Peg Grafana consumer",
  );
});

test("peg PromQL ACK and rollover-stuck rules bind only exact active", () => {
  const failures = validatePegPromqlExpressions(
    [
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'absent(mento_peg_policy_version{policy_version="europ-v2"})',
        pegRule: { kind: "rollover-ack" },
      },
    ],
    { active: "europ-v2", previous: "europ-v1" },
  );
  assert(
    failures.length === 0,
    `expected exact active ACK selector to pass: ${failures.join("\n")}`,
  );

  for (const matcher of ['="europ-v1"', '=~"^(?:europ-v2|europ-v1)$"']) {
    const rejected = validatePegPromqlExpressions(
      [
        {
          file: "rules-peg.tf",
          kind: "single",
          expr: `absent(mento_peg_policy_version{policy_version${matcher}})`,
          pegRule: { kind: "rollover-ack" },
        },
      ],
      { active: "europ-v2", previous: "europ-v1" },
    );
    assert(
      rejected.some((failure) => failure.includes("must equal active")),
      `expected ACK matcher ${matcher} to reject previous/union contamination`,
    );
  }
});

test("previous decisions cannot terminate on the active ACK", () => {
  for (const versions of [
    { active: "europ-v2", previous: "europ-v1" },
    { active: "europ-v2", previous: null },
  ]) {
    const failures = validatePegPromqlExpressions(
      [
        {
          file: "rules-peg.tf",
          kind: "single",
          expr: 'mento_peg_deviation_bps{policy_version="${local.peg_previous_policy_version}"} > 25 unless mento_peg_policy_version{policy_version="${local.peg_active_policy_version}"}',
          pegRule: { kind: "decision", policy: "previous" },
        },
      ],
      versions,
    );
    assert(
      failures.some((failure) =>
        failure.includes(
          "previous decision rules must not depend on mento_peg_policy_version",
        ),
      ),
      `expected previous decision plus active ACK gate to fail: ${failures.join("\n")}`,
    );
  }
});

test("CLI passes against the real repository", () => {
  const result = runCli();
  assert(
    result.status === 0,
    `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert(
    /PromQL expressions parsed/.test(result.stdout),
    `expected summary output, got: ${result.stdout}`,
  );
});

test("CLI accepts extracted active, previous, and ACK scopes during rollover", () => {
  const dir = mkdtempSync(join(tmpdir(), "alert-rules-rollover-test-"));
  const policy = freshPegPolicy();
  policy.previous = structuredClone(policy.active);
  sealPolicyVersion(policy.previous, "europ-v0");
  try {
    writeFileSync(join(dir, "peg-thresholds.json"), JSON.stringify(policy));
    writeFileSync(
      join(dir, "rules-peg.tf"),
      [
        "locals {",
        '  peg_active_deviation_promql = "mento_peg_deviation_bps{policy_version=\\"${local.peg_active_policy_version}\\"} > 25"',
        '  peg_previous_deviation_promql = "mento_peg_deviation_bps{policy_version=\\"${local.peg_previous_policy_version}\\"} > 25"',
        '  peg_rollover_ack_health_expr = "absent(mento_peg_policy_version{policy_version=\\"${local.peg_active_policy_version}\\"})"',
        "}",
        "",
      ].join("\n"),
    );

    const result = runCli({
      env: {
        ALERT_RULES_LINT_RULES_DIR: dir,
        ALERT_RULES_LINT_MIN_EXPRESSIONS: "3",
        ALERT_RULES_LINT_MIN_REFERENCED: "2",
      },
    });
    assert(
      result.status === 0,
      `expected rollover CLI exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trading-mode notification templates avoid single-alert duplicate headings", () => {
  const source = readFileSync(
    path.resolve(repoRoot, "alerts/rules/message-templates-victorops.tf"),
    "utf8",
  );
  const titleStart = source.indexOf(
    'resource "grafana_message_template" "victorops_trading_mode_alert_title"',
  );
  const titleEnd = source.indexOf(
    'resource "grafana_message_template" "victorops_trading_mode_alert_message"',
  );
  assert(titleStart >= 0 && titleEnd > titleStart, "title template not found");

  const titleTemplate = source.slice(titleStart, titleEnd);
  // These assertions match exact whitespace in the Terraform template.
  // If you reformat the guarded template lines, update these strings.
  assert(
    titleTemplate.includes(
      '{{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end -}}{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}{{ $chain := .Labels.chain | title -}}{{ $rateFeedWithSlash }} [{{ $chain }}]{{ end -}}',
    ),
    "VictorOps firing title should render the stable affected market",
  );
  assert(
    titleTemplate.includes(
      '{{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end -}}{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}{{ $chain := .Labels.chain | title -}}{{ $rateFeedWithSlash }} [{{ $chain }}]{{ end -}}',
    ),
    "VictorOps resolved title should render the stable affected market",
  );
  assert(
    !titleTemplate.includes(": Trading halted by breaker"),
    "VictorOps title should not repeat state in entity_display_name",
  );
  assert(
    !titleTemplate.includes(": Trading resumed"),
    "VictorOps title should not repeat resolved state in entity_display_name",
  );

  const messageStart = source.indexOf(
    'resource "grafana_message_template" "victorops_trading_mode_alert_message"',
  );
  const messageEnd = source.indexOf(
    'resource "grafana_message_template" "victorops_trading_limits_alert_title"',
  );
  assert(
    messageStart >= 0 && messageEnd > messageStart,
    "message template not found",
  );
  const messageTemplate = source.slice(messageStart, messageEnd);
  const resolvedStart = messageTemplate.indexOf(
    "{{ range .Alerts.Resolved -}}",
  );
  const resolvedEnd = messageTemplate.indexOf(
    "{{ if eq $firingCount 0 }}No alerts are currently firing.",
    resolvedStart,
  );
  assert(
    resolvedStart >= 0 && resolvedEnd > resolvedStart,
    "resolved message block not found",
  );
  const resolvedTemplate = messageTemplate.slice(resolvedStart, resolvedEnd);

  assert(
    messageTemplate.includes(
      "{{ if or $mixedState (gt $firingCount 1) -}}\n{{ $rateFeedWithSlash }} [{{ $chain }}]: Trading halted by breaker\n{{ else -}}\nTrading halted by breaker.\n{{ end -}}\n{{ if $chainlinkURL -}}",
    ),
    "VictorOps state_message should carry per-feed firing context when multi-alert or mixed",
  );
  assert(
    messageTemplate.includes(
      "{{ if or $mixedState (gt $resolvedCount 1) -}}\n{{ $rateFeedWithSlash }} [{{ $chain }}]: Trading resumed\n{{ else -}}\nTrading resumed.\n{{ end -}}",
    ),
    "VictorOps state_message should carry resolved state outside entity_display_name",
  );
  assert(
    resolvedTemplate.includes("- Chainlink data source: {{ $chainlinkURL }}"),
    "VictorOps resolved state_message should include Chainlink URLs when available",
  );
  assert(
    source.includes(
      "{{ if eq $firingCount 0 }}No alerts are currently firing.",
    ),
    "the resolved footer should use the computed firing count",
  );
});

test("oracle expiry notifications lead with human impact and action", () => {
  const victorops = readFileSync(
    path.resolve(repoRoot, "alerts/rules/message-templates-victorops.tf"),
    "utf8",
  );
  assert(
    victorops.includes("P1 {{ range") &&
      victorops.includes("oracle report expired"),
    "VictorOps title should identify the page, chain, feed, and failure",
  );
  assert(
    victorops.includes(
      "{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end -}}",
    ),
    "VictorOps title should surface both states in mixed notification batches",
  );
  assert(
    victorops.includes("Swaps using this feed may revert") &&
      victorops.includes("ACTION: Check whether relay-"),
    "VictorOps message should state impact and the next action",
  );
  assert(
    !victorops.includes("FIRING: Stale price for"),
    "VictorOps message should not use the old ambiguous stale-price copy",
  );
  const staleMessageStart = victorops.indexOf(
    'resource "grafana_message_template" "victorops_oracle_stale_price_alert_message"',
  );
  const staleMessageEnd = victorops.indexOf(
    'resource "grafana_message_template" "victorops_oracle_relayer_low_balance_alert_title"',
  );
  assert(
    staleMessageStart >= 0 && staleMessageEnd > staleMessageStart,
    "stale-price VictorOps message template not found",
  );
  const staleMessage = victorops.slice(staleMessageStart, staleMessageEnd);
  assert(
    !staleMessage.includes("No alerts are currently firing."),
    "resolve-only pages should start directly with the recovery message",
  );
  const slack = readFileSync(
    path.resolve(repoRoot, "alerts/rules/message-templates-slack.tf"),
    "utf8",
  );
  assert(
    slack.includes(
      "If this is an FX feed during the weekend market closure, snooze it and escalate the monitoring configuration",
    ),
    "Slack should carry the same weekend-FX routing guidance as VictorOps",
  );
});

test("Slack trading-mode bodies suppress duplicate single-alert headings", () => {
  const source = readFileSync(
    path.resolve(repoRoot, "alerts/rules/message-templates-slack.tf"),
    "utf8",
  );
  assert(
    source.includes(
      "{{ if or $mixedState (gt $firingCount 1) -}}\n*{{ if $mixedState }}🚨 {{ end }}{{ $rateFeedWithSlash }} [{{ $chain }}]: Trading halted by breaker*\n{{ end -}}\n{{ if $chainlinkURL -}}",
    ),
    "single firing Slack bodies should start with next action instead of repeating the title",
  );
  assert(
    source.includes(
      "{{ if or $mixedState (gt $resolvedCount 1) -}}\n*{{ if $mixedState }}✅ {{ end }}{{ $rateFeedWithSlash }} [{{ $chain }}]: Trading resumed*\n{{ end -}}\n{{ end -}}\n\n{{ if eq $firingCount 0 }}No alerts are currently firing",
    ),
    "single resolved Slack bodies should not repeat the resolved title line",
  );
  assert(
    source.includes(
      "<{{ $chainlinkURL }}|Chainlink {{ $rateFeedWithSlash }} data source>",
    ),
    "native Slack trading-mode firing body should keep Chainlink links",
  );
});

test("Polygon-family EUROPEUR staleness bypasses relayer remediation", () => {
  const ruleSource = readFileSync(
    path.resolve(repoRoot, "alerts/rules/rules-oracle-relayers.tf"),
    "utf8",
  );
  const ruleGuardStart = ruleSource.indexOf("{{ if and");
  const ruleGuardEnd = ruleSource.indexOf(" }}", ruleGuardStart);
  const fixedReportGuard = ruleSource.slice(ruleGuardStart, ruleGuardEnd);
  assert(
    ruleGuardStart >= 0 &&
      ruleGuardEnd > ruleGuardStart &&
      fixedReportGuard.includes("$labels.chain") &&
      fixedReportGuard.includes("polygon") &&
      fixedReportGuard.includes("polygon-testnet") &&
      fixedReportGuard.includes("$labels.rateFeed") &&
      fixedReportGuard.includes("EUROPEUR"),
    "the fixed-report exception should cover Polygon mainnet and Amoy EUROPEUR",
  );
  assert(
    ruleSource.includes(
      "Check the deployment/migration owner responsible for the fixed 1.0 SortedOracles report.",
    ) && ruleSource.includes("Check whether the oracle relayer is executing"),
    "Polygon-family EUROPEUR should point to the fixed-report owner while other feeds keep relayer guidance",
  );

  for (const relativePath of [
    "alerts/rules/message-templates-slack.tf",
    "alerts/rules/message-templates-victorops.tf",
  ]) {
    const source = readFileSync(path.resolve(repoRoot, relativePath), "utf8");
    const branchStart = source.indexOf(
      '{{ if and (or (eq .Labels.chain "polygon") (eq .Labels.chain "polygon-testnet")) (eq .Labels.rateFeed "EUROPEUR") -}}',
    );
    const branchEnd = source.indexOf("{{ else -}}", branchStart);
    assert(
      branchStart >= 0 && branchEnd > branchStart,
      relativePath + " should have a Polygon-family EUROPEUR branch",
    );
    const fixedReportBranch = source.slice(branchStart, branchEnd);
    assert(
      fixedReportBranch.includes("SortedOracles") &&
        fixedReportBranch.includes("deployment/migration owner"),
      relativePath +
        " should route Polygon-family EUROPEUR to the fixed-report owner",
    );
    assert(
      !fixedReportBranch.includes("relayer") &&
        !fixedReportBranch.includes("relay-") &&
        !fixedReportBranch.includes("cloud function") &&
        !fixedReportBranch.includes("Logs:"),
      relativePath +
        " should not send Polygon-family EUROPEUR through relayer remediation",
    );
  }
});

test("trading-mode Splunk pages repeat slowly per rate feed", () => {
  const source = readFileSync(
    path.resolve(repoRoot, "alerts/rules/notification-policies.tf"),
    "utf8",
  );
  const matchingBlocks = blocksFor(source, 'dynamic "policy"').filter(
    (block) =>
      /\bcontact_point\s*=\s*grafana_contact_point\.splunk_on_call\.name/.test(
        block,
      ) &&
      /\blabel\s*=\s*"service"[\s\S]*?\bvalue\s*=\s*"exchanges"/.test(block) &&
      /\blabel\s*=\s*"severity"[\s\S]*?\bvalue\s*=\s*"page"/.test(block),
  );
  assert(
    matchingBlocks.length === 1,
    `expected one trading-mode Splunk page policy, got ${matchingBlocks.length}`,
  );

  const [splunkPolicy] = matchingBlocks;
  assert(
    /\bcontact_point\s*=\s*grafana_contact_point\.splunk_on_call\.name/.test(
      splunkPolicy,
    ),
    "trading-mode page policy should route to Splunk On-Call",
  );
  assert(
    /\bgroup_by\s*=\s*\[\s*"alertname"\s*,\s*"chain"\s*,\s*"rateFeed"\s*\]/.test(
      splunkPolicy,
    ),
    "trading-mode pages should group by rateFeed so new pairs page immediately",
  );
  assert(
    /\bgroup_wait\s*=\s*"30s"/.test(splunkPolicy),
    "trading-mode pages should keep the initial page fast",
  );
  assert(
    /\bgroup_interval\s*=\s*"5m"/.test(splunkPolicy),
    "trading-mode pages should keep resolve and group updates prompt",
  );
  assert(
    /\brepeat_interval\s*=\s*"1d"/.test(splunkPolicy),
    "trading-mode pages should not repeat SMS/pager notifications more than daily",
  );
  assert(
    /\bcontinue\s*=\s*true/.test(splunkPolicy),
    "trading-mode Splunk policy must continue so Slack alerts-critical also fires",
  );
});

test("trading-mode alerts keep incidents open across short flaps", () => {
  const tradingModeRules = readFileSync(
    path.resolve(repoRoot, "alerts/rules/rules-trading-modes.tf"),
    "utf8",
  );
  assert(
    /^(?![ \t]*#).*\bfor\s*=\s*"5m"/m.test(tradingModeRules),
    "trading-mode alerts should still page quickly after a sustained halt",
  );
  assert(
    /^(?![ \t]*#).*\bkeep_firing_for\s*=\s*"1h"/m.test(tradingModeRules),
    "trading-mode alerts should keep incidents open across short breaker flaps",
  );
});

// Rule blocks are written as `rule {` directly, or as `content {` inside a
// `dynamic "rule"` loop. Comments are stripped first so a rationale comment
// quoting an attribute cannot satisfy an assertion.
function ruleBlockNamed(source, namePattern) {
  const stripped = stripComments(source);
  const blocks = [
    ...blocksFor(stripped, "rule {"),
    ...blocksFor(stripped, "content {"),
  ].filter((block) => namePattern.test(block));
  assert(
    blocks.length === 1,
    `expected exactly one rule block matching ${namePattern}, got ${blocks.length}`,
  );
  return blocks[0];
}

test("flap-prone criticals keep incidents open across short recoveries", () => {
  const fpmmRules = readFileSync(
    path.resolve(repoRoot, "alerts/rules/rules-fpmms.tf"),
    "utf8",
  );
  const relayerRules = readFileSync(
    path.resolve(repoRoot, "alerts/rules/rules-oracle-relayers.tf"),
    "utf8",
  );

  assert(
    /\bkeep_firing_for\s*=\s*"1h"/.test(
      ruleBlockNamed(fpmmRules, /\bname\s*=\s*"Rebalancer Stale"/),
    ),
    "Rebalancer Stale should hold the incident open for 1h across short recoveries",
  );

  assert(
    /\bkeep_firing_for\s*=\s*"30m"/.test(
      ruleBlockNamed(relayerRules, /\bname\s*=\s*"Oldest Report Expired \[/),
    ),
    "Oldest Report Expired should absorb relayer catch-up cycles for 30m",
  );

  // The banded depletion tiers are the exception, and it is load-bearing. A
  // hold on either band keeps it firing while a pool crosses into the other,
  // which is exactly the double notification the partition exists to prevent.
  for (const namePattern of [
    /\bname\s*=\s*"Pool Depletion Risk"/,
    /\bname\s*=\s*"Pool Nearly One-Sided"/,
  ]) {
    assert(
      !/\bkeep_firing_for\s*=/.test(ruleBlockNamed(fpmmRules, namePattern)),
      `${namePattern} must NOT hold its incident open — a held band double-notifies with its neighbour on every tier crossing`,
    );
  }
});

test("long-lived pool criticals repeat twice daily, short-lived ones hourly", () => {
  const contactPoints = readFileSync(
    path.resolve(repoRoot, "alerts/rules/contact-points.tf"),
    "utf8",
  );
  const stripped = stripComments(contactPoints);
  const [poolRoute] = blocksFor(stripped, "notify_critical_pool = ");
  const [slowRoute] = blocksFor(stripped, "notify_critical_pool_slow = ");
  assert(poolRoute, "notify_critical_pool local should exist");
  assert(slowRoute, "notify_critical_pool_slow local should exist");
  assert(
    /\brepeat_interval\s*=\s*"1h"/.test(poolRoute),
    "the shared pool-critical route must keep its hourly repeat for other consumers",
  );
  assert(
    /\brepeat_interval\s*=\s*"12h"/.test(slowRoute),
    "a weeks-long pool breach should re-notify #alerts-critical twice a day, not 24 times",
  );

  // The slow variant must differ from the shared one in repeat cadence only.
  // Compare every attribute the two locals declare rather than a hand-listed
  // subset, so an attribute added to one local and not the other is caught
  // without anyone remembering to extend this test.
  const attributesExceptRepeat = (block) =>
    Object.fromEntries(
      // Slice past the `<name> = {` header so the local's own name is not
      // read as an attribute — the two locals have different names by design.
      [
        ...block
          .slice(block.indexOf("{") + 1)
          .matchAll(/^\s*(\w+)\s*=\s*(.+?)\s*$/gm),
      ]
        .map(([, key, value]) => [key, value])
        .filter(([key]) => key !== "repeat_interval"),
    );
  const poolAttributes = attributesExceptRepeat(poolRoute);
  const slowAttributes = attributesExceptRepeat(slowRoute);
  // Named-presence check and union comparison cover different failures: this
  // catches a required attribute missing from BOTH locals (or a regex that
  // silently parsed nothing), the loop below catches the two diverging.
  for (const key of [
    "contact_point",
    "group_by",
    "group_wait",
    "group_interval",
  ]) {
    assert(
      Object.hasOwn(poolAttributes, key) && Object.hasOwn(slowAttributes, key),
      `both pool-critical routes should declare ${key}`,
    );
  }
  for (const key of new Set([
    ...Object.keys(poolAttributes),
    ...Object.keys(slowAttributes),
  ])) {
    assert(
      poolAttributes[key] === slowAttributes[key],
      `notify_critical_pool_slow should differ from notify_critical_pool in repeat_interval only, but ${key} differs: ${poolAttributes[key]} vs ${slowAttributes[key]}`,
    );
  }

  // Only the long-lived pool-balance criticals take the slow cadence; the
  // oracle and trading-limit criticals in the same file stay hourly.
  const fpmmRules = readFileSync(
    path.resolve(repoRoot, "alerts/rules/rules-fpmms.tf"),
    "utf8",
  );
  const slowRules = [
    /\bname\s*=\s*"Pool Depletion Risk"/,
    /\bname\s*=\s*"Rebalancer Stale"/,
  ];
  const hourlyRules = [
    /\bname\s*=\s*"Oracle Contract Down"/,
    /\bname\s*=\s*"Oracle Down"/,
    /\bname\s*=\s*"Oracle Liveness Critical"/,
    /\bname\s*=\s*"Trading Limit Tripped"/,
  ];
  for (const namePattern of slowRules) {
    assert(
      /\blocal\.notify_critical_pool_slow\b/.test(
        ruleBlockNamed(fpmmRules, namePattern),
      ),
      `${namePattern} should notify through notify_critical_pool_slow`,
    );
  }
  for (const namePattern of hourlyRules) {
    assert(
      /\blocal\.notify_critical_pool\b/.test(
        ruleBlockNamed(fpmmRules, namePattern),
      ),
      `${namePattern} should stay on the hourly notify_critical_pool route`,
    );
  }
});

test("pool pages deliver through one bundled contact point, never the policy tree", () => {
  const fpmmRules = readFileSync(
    path.resolve(repoRoot, "alerts/rules/rules-fpmms.tf"),
    "utf8",
  );
  const contactPoints = readFileSync(
    path.resolve(repoRoot, "alerts/rules/contact-points.tf"),
    "utf8",
  );
  const policies = stripComments(
    readFileSync(
      path.resolve(repoRoot, "alerts/rules/notification-policies.tf"),
      "utf8",
    ),
  );

  const pageRule = ruleBlockNamed(
    fpmmRules,
    /\bname\s*=\s*"Pool Nearly One-Sided"/,
  );
  assert(
    /\bseverity\s*=\s*"page"/.test(pageRule),
    "the one-sided-pool rule should carry the repo's page severity label",
  );
  assert(
    /\blocal\.notify_page_pool\b/.test(pageRule),
    "a page-severity fpmms rule still needs rule-level notification_settings",
  );

  const stripped = stripComments(contactPoints);
  const [pageRoute] = blocksFor(stripped, "notify_page_pool = ");
  assert(pageRoute, "notify_page_pool local should exist");
  assert(
    /\bcontact_point\s*=\s*grafana_contact_point\.pool_page\.name/.test(
      pageRoute,
    ),
    "pool pages should route to the bundled Splunk + Slack contact point",
  );

  // One contact point carrying both destinations is what makes the page
  // single-delivery: rule-level notification_settings bypass the policy tree,
  // so a second destination has to live inside the same contact point.
  const [pageContactPoint] = blocksFor(
    stripped,
    'resource "grafana_contact_point" "pool_page"',
  );
  assert(pageContactPoint, "grafana_contact_point.pool_page should exist");
  for (const destination of ["slack {", "victorops {"]) {
    assert(
      pageContactPoint.includes(destination),
      `the bundled page contact point should carry a ${destination.replace(" {", "")} destination`,
    );
  }

  // The other half of "cannot double-fire": no policy-tree branch matches the
  // fpmms plane, so nothing can deliver the same page a second time.
  assert(
    !/\bvalue\s*=\s*"fpmms"/.test(policies),
    "the label-routed policy tree must not match service=fpmms — fpmms rules route rule-level, and a matching branch would double-deliver",
  );
});

test("oracle-driven criticals group per incident, not per pool", () => {
  const contactPoints = readFileSync(
    path.resolve(repoRoot, "alerts/rules/contact-points.tf"),
    "utf8",
  );
  const stripped = stripComments(contactPoints);
  const [incidentRoute] = blocksFor(stripped, "notify_critical_incident = ");
  assert(incidentRoute, "notify_critical_incident local should exist");
  assert(
    /\bcontact_point\s*=\s*grafana_contact_point\.slack_critical\.name/.test(
      incidentRoute,
    ),
    "incident-grouped criticals should still route to #alerts-critical",
  );
  assert(
    /\bgroup_by\s*=\s*\[\s*"alertname"\s*,\s*"grafana_folder"\s*,\s*"chain_id"\s*\]/.test(
      incidentRoute,
    ),
    "incident grouping must drop pool_id so one upstream failure sends one message",
  );
  assert(
    /\brepeat_interval\s*=\s*"1h"/.test(incidentRoute),
    "incident grouping changes message count, not the hourly critical repeat",
  );

  // Service-scoped criticals (metrics-bridge) have no pool labels; without
  // `alertname` they would collapse into a single folder-level group.
  const [serviceRoute] = blocksFor(stripped, "notify_critical = ");
  assert(serviceRoute, "notify_critical local should exist");
  assert(
    /\bgroup_by\s*=\s*\[[^\]]*"alertname"/.test(serviceRoute),
    "service-scoped criticals must keep alertname in group_by",
  );

  for (const [relativePath, namePattern] of [
    ["alerts/rules/rules-vp-oracles.tf", /"VirtualPool Oracle Stale \(prod\)"/],
    ["alerts/rules/rules-fpmms.tf", /"Oracle Jump Far Above Swap Fee"/],
  ]) {
    const source = readFileSync(path.resolve(repoRoot, relativePath), "utf8");
    const block = ruleBlockNamed(source, namePattern);
    assert(
      /\bcontact_point\s*=\s*local\.notify_critical_incident\.contact_point/.test(
        block,
      ) && !/\blocal\.notify_critical_pool\b/.test(block),
      `${relativePath} ${namePattern} should notify through notify_critical_incident`,
    );
  }
});

test("CLI recognizes gauges registered by the peg listing module", () => {
  const dir = mkdtempSync(join(tmpdir(), "alert-rules-lint-test-"));
  try {
    writeFileSync(
      join(dir, "peg-listing.tf"),
      [
        "locals {",
        '  peg_active_listing_promql = "mento_peg_listing_state{asset=\\"europ-schuman\\",source=\\"bitvavo_eur\\",state=\\"absent\\",policy_version=\\"${local.peg_active_policy_version}\\"}"',
        "}",
        "",
      ].join("\n"),
    );
    const result = runCli({
      env: {
        ALERT_RULES_LINT_RULES_DIR: dir,
        ALERT_RULES_LINT_PEG_POLICY: path.resolve(
          repoRoot,
          "alerts/rules/peg-thresholds.json",
        ),
        ALERT_RULES_LINT_PEG_REGISTRY: path.resolve(
          repoRoot,
          "metrics-bridge/peg-registry.json",
        ),
        ALERT_RULES_LINT_MIN_EXPRESSIONS: "1",
        ALERT_RULES_LINT_MIN_REFERENCED: "1",
      },
    });
    assert(
      result.status === 0,
      `expected exit 0, got ${result.status}: ${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI reports parse failures and unknown bridge metrics", () => {
  const dir = mkdtempSync(join(tmpdir(), "alert-rules-lint-test-"));
  try {
    writeFileSync(
      join(dir, "broken.tf"),
      [
        'expr = "sum(rate(broken["',
        'labels = { metric = "mento_pool_does_not_exist" }',
        "",
      ].join("\n"),
    );
    const result = runCli({
      env: {
        ALERT_RULES_LINT_RULES_DIR: dir,
        ALERT_RULES_LINT_MIN_EXPRESSIONS: "1",
        ALERT_RULES_LINT_MIN_REFERENCED: "1",
      },
    });
    assert(result.status === 1, `expected exit 1, got ${result.status}`);
    assert(
      /broken\.tf/.test(result.stderr),
      `expected parse failure to name file, got: ${result.stderr}`,
    );
    assert(
      /mento_pool_does_not_exist/.test(result.stderr),
      `expected unknown metric failure, got: ${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed.\n`);
  process.exit(1);
}

process.stdout.write(`${passed} tests passed.\n`);
