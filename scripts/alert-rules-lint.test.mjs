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
  referencedMetricNames,
  registeredMetricNames,
  stripComments,
  unescapeHcl,
} from "./alert-rules-lint.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const script = path.resolve(__dirname, "alert-rules-lint.mjs");

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
    { name: "not_a_mento_metric" },
  `);
  assert(
    JSON.stringify(registered) ===
      JSON.stringify(["mento_pool_oracle_ok", "mento_cdp_shutdown"]),
    `unexpected registered names: ${JSON.stringify(registered)}`,
  );

  const referenced = referencedMetricNames(`
    expr = "mento_pool_oracle_ok + mento_cdp_shutdown + mento_other_ignored"
  `);
  assert(
    JSON.stringify(referenced) ===
      JSON.stringify(["mento_pool_oracle_ok", "mento_cdp_shutdown"]),
    `unexpected referenced names: ${JSON.stringify(referenced)}`,
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

test("VictorOps trading-mode title is stable and body carries state", () => {
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
  assert(
    !titleTemplate.includes("Trading halted by breaker"),
    "VictorOps title should be the stable entity label, not the firing state",
  );
  assert(
    !titleTemplate.includes("Trading resumed"),
    "VictorOps title should be the stable entity label, not the recovery state",
  );

  // These checks intentionally match exact whitespace in the Terraform
  // template. If you reformat the guarded template lines, update these strings.
  assert(
    titleTemplate.includes(
      '{{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end -}}{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}{{ $chain := .Labels.chain | title -}}{{ $rateFeedWithSlash }} [{{ $chain }}]{{ end -}}',
    ),
    "VictorOps firing title should render the affected market only",
  );
  assert(
    source.includes(
      "{{ if or $mixedState (gt $firingCount 1) -}}\n{{ $rateFeedWithSlash }} [{{ $chain }}]: Trading halted by breaker\n{{ else -}}\nTrading halted by breaker for {{ $rateFeedWithSlash }} [{{ $chain }}].\n{{ end -}}\n{{ if $chainlinkURL -}}",
    ),
    "single firing bodies should carry the state without repeating the entity title",
  );
  assert(
    source.includes(
      "Trading resumed for {{ $rateFeedWithSlash }} [{{ $chain }}].",
    ),
    "resolved trading-mode bodies should use resumed wording",
  );
  assert(
    source.includes(
      "{{ if eq $firingCount 0 }}No alerts are currently firing.",
    ),
    "the resolved footer should use the computed firing count",
  );
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
    /\brepeat_interval\s*=\s*"24h"/.test(splunkPolicy),
    "trading-mode pages should not repeat SMS/pager notifications more than daily",
  );
  assert(
    /\bcontinue\s*=\s*true/.test(splunkPolicy),
    "trading-mode Splunk policy must continue so Slack alerts-critical also fires",
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
