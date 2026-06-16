#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expressions.length === 9,
    `expected 9 expressions, got ${expressions.length}: ${JSON.stringify(expressions)}`,
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
