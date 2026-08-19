#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attributeExpression,
  normalizeExpression,
  terraformTopLevelBlocks,
} from "../../lib/hcl.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const alertsInfraRoot = path.join(repoRoot, "alerts/infra");
const bridgeRoot = path.join(alertsInfraRoot, "channels/sentry-bridge");

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function terraformFiles(root, relativeRoot = path.relative(repoRoot, root)) {
  const files = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".terraform")) continue;
    const absolutePath = path.join(root, entry.name);
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, terraformFiles(absolutePath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".tf")) {
      files[relativePath] = readFileSync(absolutePath, "utf8");
    }
  }
  return files;
}

function requireSingleBlock(blocks, kind, labels, label) {
  const matches = blocks.filter(
    (block) =>
      block.kind === kind &&
      block.labels.length === labels.length &&
      block.labels.every((value, index) => value === labels[index]),
  );
  assert.equal(matches.length, 1, `${label} must exist exactly once`);
  return matches[0];
}

function exactEmptyObjectKeys(block, attribute) {
  const code = block.code;
  const assignment = new RegExp(`\\b${attribute}\\s*=\\s*\\[`, "u").exec(code);
  assert(assignment, `${block.name}.${attribute} must be an explicit list`);
  const start = assignment.index + assignment[0].lastIndexOf("[");
  let depth = 0;
  let end = -1;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === "[") depth += 1;
    if (code[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  assert(end > start, `${block.name}.${attribute} must close its list`);
  const body = code.slice(start + 1, end - 1);
  const entries = [
    ...body.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*\}\s*\}/gu),
  ].map((match) => match[1]);
  const residue = body
    .replace(/\{\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\{\s*\}\s*\}/gu, "")
    .replace(/[\s,]/gu, "");
  assert.equal(
    residue,
    "",
    `${block.name}.${attribute} must contain only explicit empty-object triggers`,
  );
  return entries;
}

function assertExactSentryConstraint(relativePath) {
  const source = readRepoFile(relativePath);
  const sentryBlock = /sentry\s*=\s*\{(?<body>[\s\S]*?)^\s*\}/mu.exec(source)
    ?.groups?.body;
  assert(sentryBlock, `${relativePath} must declare the Sentry provider`);
  assert.match(sentryBlock, /^\s*source\s*=\s*"jianyuan\/sentry"\s*$/mu);
  assert.match(sentryBlock, /^\s*version\s*=\s*"0\.15\.4"\s*$/mu);
  assert.doesNotMatch(sentryBlock, /0\.15\.0-beta3/u);
}

assertExactSentryConstraint("alerts/infra/versions.tf");
assertExactSentryConstraint("alerts/infra/channels/sentry-bridge/versions.tf");

const lockfile = readRepoFile("alerts/infra/.terraform.lock.hcl");
const sentryLockBlocks = [
  ...lockfile.matchAll(
    /provider "registry\.terraform\.io\/jianyuan\/sentry" \{(?<body>[\s\S]*?)^\}/gmu,
  ),
];
assert.equal(
  sentryLockBlocks.length,
  1,
  "lockfile must contain one Sentry entry",
);
assert.match(
  sentryLockBlocks[0].groups.body,
  /^\s*version\s*=\s*"0\.15\.4"$/mu,
);
assert.match(
  sentryLockBlocks[0].groups.body,
  /^\s*constraints\s*=\s*"0\.15\.4"$/mu,
);
assert.doesNotMatch(sentryLockBlocks[0].groups.body, /0\.15\.0-beta3/u);

const allTerraformFiles = terraformFiles(alertsInfraRoot);
const parseErrors = [];
const allBlocks = terraformTopLevelBlocks(allTerraformFiles, parseErrors);
assert.deepEqual(parseErrors, [], "alerts-delivery Terraform must parse");
assert.equal(
  allBlocks.filter(
    (block) =>
      block.kind === "resource" && block.labels[0] === "sentry_issue_alert",
  ).length,
  0,
  "legacy sentry_issue_alert resources are forbidden",
);

const bridgeFiles = terraformFiles(bridgeRoot);
const bridgeBlocks = terraformTopLevelBlocks(bridgeFiles);
const sentryAlerts = bridgeBlocks.filter(
  (block) => block.kind === "resource" && block.labels[0] === "sentry_alert",
);
assert.deepEqual(
  sentryAlerts.map((block) => block.labels[1]).sort(),
  ["slack_critical_fanout", "slack_default"],
  "the bridge must own exactly the default and critical Sentry fan-outs",
);

const defaultAlert = requireSingleBlock(
  bridgeBlocks,
  "resource",
  ["sentry_alert", "slack_default"],
  "default Sentry fan-out",
);
const criticalAlert = requireSingleBlock(
  bridgeBlocks,
  "resource",
  ["sentry_alert", "slack_critical_fanout"],
  "critical Sentry fan-out",
);
const monitorExpression =
  "[data.sentry_project_issue_stream_monitor.default[each.key].id]";

for (const block of [defaultAlert, criticalAlert]) {
  assert.equal(
    normalizeExpression(attributeExpression(block, "for_each")),
    "local.projects",
    `${block.name} must fan out to every discovered project`,
  );
  assert.equal(
    normalizeExpression(attributeExpression(block, "monitor_ids")),
    monitorExpression,
    `${block.name} must use the project's explicit issue-stream monitor`,
  );
}

assert.deepEqual(
  exactEmptyObjectKeys(defaultAlert, "trigger_conditions"),
  ["first_seen_event", "regression_event", "reappeared_event"],
  "default fan-out trigger list changed",
);
assert.deepEqual(
  exactEmptyObjectKeys(criticalAlert, "trigger_conditions"),
  ["first_seen_event", "regression_event"],
  "critical fan-out trigger list changed",
);
assert.equal(
  attributeExpression(defaultAlert, "channel_name"),
  '"sentry-${each.key}"',
  "per-project routing must retain the bare channel name",
);
assert.equal(
  normalizeExpression(attributeExpression(defaultAlert, "channel_id")),
  "restapi_object.sentry_slack_channel[each.key].id",
  "per-project routing must retain its exact Slack channel ID",
);
assert.equal(
  normalizeExpression(attributeExpression(criticalAlert, "channel_name")),
  "var.slack_critical_channel",
  "critical routing must use the validated channel variable",
);
assert.equal(
  normalizeExpression(attributeExpression(criticalAlert, "channel_id")),
  "var.slack_critical_channel_id",
  "critical routing must retain its matching channel ID",
);

for (const [relativePath, variableName] of [
  ["alerts/infra/variables.tf", "sentry_slack_critical_channel"],
  [
    "alerts/infra/channels/sentry-bridge/variables.tf",
    "slack_critical_channel",
  ],
]) {
  const blocks = terraformTopLevelBlocks({
    [relativePath]: readRepoFile(relativePath),
  });
  const variable = requireSingleBlock(
    blocks,
    "variable",
    [variableName],
    `${relativePath} ${variableName}`,
  );
  assert.equal(
    attributeExpression(variable, "default"),
    '"#alerts-critical"',
    `${variableName} must default to the delivery-safe prefixed channel`,
  );
  assert.match(
    variable.text,
    /condition\s*=\s*can\(regex\("\^#",\s*var\.[a-z_]+\)\)/u,
    `${variableName} must reject a bare critical channel`,
  );
}

console.log("Sentry provider contract tests passed");
