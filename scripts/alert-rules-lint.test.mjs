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
const script = path.resolve(__dirname, "alert-rules-lint.mjs");
const pegPolicyFixture = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "..", "alerts/rules/peg-thresholds.json"),
    "utf8",
  ),
);
const pegRegistryFixture = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "..", "metrics-bridge/peg-registry.json"),
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
    cwd: path.resolve(__dirname, ".."),
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

test("previous decision may gate on exact active ACK", () => {
  const failures = validatePegPromqlExpressions(
    [
      {
        file: "rules-peg.tf",
        kind: "single",
        expr: 'mento_peg_deviation_bps{policy_version="europ-v1"} > 25 unless mento_peg_policy_version{policy_version="europ-v2"}',
        pegRule: { kind: "decision", policy: "previous" },
      },
    ],
    { active: "europ-v2", previous: "europ-v1" },
  );
  assert(
    failures.length === 0,
    `expected previous decision plus active ACK gate to pass: ${failures.join("\n")}`,
  );
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
    path.resolve(
      __dirname,
      "..",
      "alerts/rules/message-templates-victorops.tf",
    ),
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
    path.resolve(
      __dirname,
      "..",
      "alerts/rules/message-templates-victorops.tf",
    ),
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
    path.resolve(__dirname, "..", "alerts/rules/message-templates-slack.tf"),
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
    path.resolve(__dirname, "..", "alerts/rules/message-templates-slack.tf"),
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
    path.resolve(__dirname, "..", "alerts/rules/rules-oracle-relayers.tf"),
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
    const source = readFileSync(
      path.resolve(__dirname, "..", relativePath),
      "utf8",
    );
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
    path.resolve(__dirname, "..", "alerts/rules/notification-policies.tf"),
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
    path.resolve(__dirname, "..", "alerts/rules/rules-trading-modes.tf"),
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
