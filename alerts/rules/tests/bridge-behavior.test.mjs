import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const promtool = process.env.PROMTOOL ?? "promtool";

function command(binary, args, options = {}) {
  return execFileSync(binary, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

function evaluateContract(directory, thresholdOverrides = {}) {
  const module = join(directory, "alerts/rules");
  mkdirSync(module, { recursive: true });
  mkdirSync(join(directory, "shared-config"));
  copyFileSync(
    join(repo, "alerts/rules/bridge-promql.tf"),
    join(module, "bridge-promql.tf"),
  );
  copyFileSync(
    join(repo, "shared-config/bridge-thresholds.json"),
    join(directory, "shared-config/bridge-thresholds.json"),
  );
  const thresholdPath = join(directory, "shared-config/bridge-thresholds.json");
  const thresholds = JSON.parse(readFileSync(thresholdPath, "utf8"));
  writeFileSync(
    thresholdPath,
    JSON.stringify({ ...thresholds, ...thresholdOverrides }),
  );
  // This module has only the exact rule locals and shared JSON. It has no
  // providers, backend, resources or production inputs. Never plan the live root.
  const env = { ...process.env, TF_DATA_DIR: join(directory, ".terraform") };
  for (const key of Object.keys(env))
    if (key.startsWith("TF_CLI_ARGS")) delete env[key];
  command(
    "terraform",
    [`-chdir=${module}`, "init", "-backend=false", "-input=false"],
    { env },
  );
  const encoded = command("terraform", [`-chdir=${module}`, "console"], {
    env,
    input:
      "jsonencode({rules=local.bridge_rule_definitions,unavailable=local.bridge_unavailable_promql,invalid=local.bridge_invalid_promql,title=local.bridge_notification_title,body=local.bridge_notification_body})\n",
  });
  return JSON.parse(JSON.parse(encoded));
}

function scenarios(contract) {
  const tests = [];
  const names = [
    "observation_error",
    "last_success_timestamp_seconds",
    "freshness_limit_seconds",
    "invalid_rows",
    "transfers",
    "stuck_transfers",
    "oldest_state_age_seconds",
    "warning_threshold_seconds",
  ];
  const routeMetrics = new Set([
    "transfers",
    "stuck_transfers",
    "oldest_state_age_seconds",
  ]);
  function scenario(name, status, age, stuck, warning, page, options = {}) {
    const {
      last = 1000,
      error = 0,
      invalid = 0,
      missing = [],
      unavailable = 0,
      thresholdValues = {},
      missingThresholds = [],
      replicas = [],
    } = options;
    const values = [error, last, 45, invalid, 3, stuck, age];
    const route = `source_chain="137",destination_chain="143",token="USDm",status="${status}",job="metrics-bridge",instance="local"`;
    const labels = `{destination_chain="143", source_chain="137", status="${status}", token="USDm"}`;
    const regular = names.flatMap((metric, index) =>
      missing.includes(metric) || metric === "warning_threshold_seconds"
        ? []
        : [
            {
              series: `mento_ntt_bridge_${metric}{${routeMetrics.has(metric) ? route : 'job="metrics-bridge",instance="local"'}}`,
              values: `${values[index]}+0x1000`,
            },
          ],
    );
    const policy = Object.fromEntries(
      Object.values(contract.rules)
        .filter((rule) => rule.severity === "page")
        .map((rule) => [rule.status, rule.threshold]),
    );
    const policySeries = (instance, job, overrides, omitted) =>
      missing.includes("warning_threshold_seconds")
        ? []
        : Object.entries({ ...policy, ...overrides }).flatMap(
            ([status, seconds]) =>
              omitted.includes(status)
                ? []
                : [
                    {
                      series: `mento_ntt_bridge_warning_threshold_seconds{status="${status}",job="${job}",instance="${instance}"}`,
                      values: `${seconds}+0x1000`,
                    },
                  ],
          );
    const input_series = [
      ...regular,
      ...policySeries(
        "local",
        "metrics-bridge",
        thresholdValues,
        missingThresholds,
      ),
      ...replicas.flatMap(
        ({
          instance,
          job = "metrics-bridge",
          thresholds = {},
          missing = [],
        }) => [
          ...regular.map((sample) => ({
            ...sample,
            series: sample.series
              .replace('instance="local"', `instance="${instance}"`)
              .replace('job="metrics-bridge"', `job="${job}"`),
          })),
          ...policySeries(instance, job, thresholds, missing),
        ],
      ),
    ];
    const promql_expr_test = [
      ["warning", warning],
      ["page", page],
    ].map(([severity, value]) => ({
      expr: contract.rules[`${status}-${severity}`].eligible_expr,
      eval_time: "1000s",
      exp_samples: value === null ? [] : [{ labels, value }],
    }));
    promql_expr_test.push({
      expr: `(${contract.unavailable}) > bool 0`,
      eval_time: "1000s",
      exp_samples: [{ labels: "{}", value: unavailable }],
    });
    promql_expr_test.push({
      expr: contract.invalid,
      eval_time: "1000s",
      exp_samples: [
        {
          labels: "{}",
          value: !error && last > 0 && 1000 - last <= 75 ? invalid : 0,
        },
      ],
    });
    tests.push({ name, interval: "1s", input_series, promql_expr_test });
  }
  for (const status of ["PENDING", "SENT", "ATTESTED", "QUEUED_INBOUND"]) {
    const threshold = contract.rules[`${status}-page`].threshold;
    for (const [name, age, stuck, warning, page] of [
      ["boundary", threshold, 0, 0, 0],
      ["threshold-plus-one", threshold + 1, 1, 1, 0],
      ["two-stuck", threshold + 1, 2, 1, 0],
      ["three-stuck", threshold + 1, 3, 0, 1],
      ["below-double", 2 * threshold - 1, 1, 1, 0],
      ["double", 2 * threshold, 1, 0, 1],
      ["three-healthy", 10, 0, 0, 0],
    ])
      scenario(`${status}-${name}`, status, age, stuck, warning, page);
  }
  const sentThreshold = contract.rules["SENT-page"].threshold;
  scenario("fresh-exact75", "SENT", sentThreshold + 1, 1, 1, 0, { last: 925 });
  scenario("stale76", "SENT", sentThreshold + 1, 1, null, null, {
    last: 924,
    unavailable: 1,
  });
  scenario("query-failure", "SENT", sentThreshold + 1, 1, null, null, {
    error: 1,
    unavailable: 1,
  });
  scenario("unknown-data-holds-transfer", "SENT", 0, 0, null, null, {
    invalid: 1,
  });
  scenario("successful-empty-clears", "SENT", 0, 0, 0, 0);
  scenario("never-observed", "SENT", 0, 0, null, null, {
    last: 0,
    error: 1,
    missing: [
      "transfers",
      "stuck_transfers",
      "oldest_state_age_seconds",
      "invalid_rows",
    ],
    unavailable: 1,
  });
  for (const metric of names)
    scenario(`missing-${metric}`, "SENT", sentThreshold + 1, 1, null, null, {
      missing: [metric],
      unavailable: 1,
    });
  for (const factor of [0.5, 2])
    scenario(`threshold-rollout-${factor}`, "SENT", 4000, 2, null, null, {
      thresholdValues: { SENT: sentThreshold * factor },
      unavailable: 1,
    });
  for (const status of ["PENDING", "SENT", "ATTESTED", "QUEUED_INBOUND"])
    scenario(
      `missing-threshold-${status}`,
      "SENT",
      sentThreshold + 1,
      1,
      null,
      null,
      {
        missingThresholds: [status],
        unavailable: 1,
      },
    );
  scenario("extra-threshold-status", "SENT", sentThreshold + 1, 1, null, null, {
    thresholdValues: { UNKNOWN: 1 },
    unavailable: 1,
  });
  for (const replica of [
    { instance: "other" },
    { instance: "local", job: "other" },
  ])
    scenario(
      `mixed-replica-${replica.instance}-${replica.job}`,
      "SENT",
      sentThreshold + 1,
      1,
      null,
      null,
      {
        replicas: [{ ...replica, thresholds: { SENT: sentThreshold / 2 } }],
        unavailable: 1,
      },
    );
  scenario(
    "thresholds-split-across-replicas",
    "SENT",
    sentThreshold + 1,
    1,
    null,
    null,
    {
      missingThresholds: ["PENDING", "SENT"],
      replicas: [
        { instance: "other", missing: ["ATTESTED", "QUEUED_INBOUND"] },
      ],
      unavailable: 1,
    },
  );
  scenario(
    "legacy-replica-missing-handshake",
    "SENT",
    sentThreshold + 1,
    1,
    null,
    null,
    {
      replicas: [
        {
          instance: "other",
          missing: ["PENDING", "SENT", "ATTESTED", "QUEUED_INBOUND"],
        },
      ],
      unavailable: 1,
    },
  );
  scenario(
    "matching-replicas-resume-page",
    "SENT",
    sentThreshold * 2,
    2,
    0,
    1,
    {
      replicas: [{ instance: "other" }],
    },
  );
  scenario(
    "matching-policy-resume-warning",
    "SENT",
    sentThreshold + 1,
    2,
    1,
    0,
  );
  scenario("matching-policy-empty-recovery", "SENT", 0, 0, 0, 0);
  return tests;
}

test(
  "exact Terraform bridge expressions and notifications preserve alert behavior",
  { timeout: 180_000 },
  () => {
    command(promtool, ["--version"]); // Required: absence is a failure, never a silent skip.
    const directory = mkdtempSync(join(tmpdir(), "bridge-rule-behavior-"));
    try {
      const contract = evaluateContract(directory);
      const updatedDirectory = join(directory, "updated-policy");
      mkdirSync(updatedDirectory);
      const updated = evaluateContract(updatedDirectory, { SENT: 1800 });
      const tests = [...scenarios(contract), ...scenarios(updated)];
      const fixture = join(directory, "rules.test.json");
      writeFileSync(
        fixture,
        JSON.stringify({ evaluation_interval: "1s", tests }),
      );
      command(promtool, ["test", "rules", fixture]);
      const templates = join(directory, "templates.json");
      writeFileSync(templates, JSON.stringify(contract));
      command(
        "go",
        ["test", join(repo, "alerts/rules/tests/bridge-notification_test.go")],
        {
          env: {
            ...process.env,
            GOTOOLCHAIN: "local",
            BRIDGE_TEMPLATE_FIXTURE: templates,
          },
        },
      );
      process.stdout.write(
        `${tests.length} scenarios / ${tests.reduce((count, entry) => count + entry.promql_expr_test.length, 0)} exact-expression assertions passed\n`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
