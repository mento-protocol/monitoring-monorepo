import assert from "node:assert/strict";

import {
  buildSlackPayload,
  formatResourceActions,
  formatTypeSummary,
  parsePullRequestNumberFromCommitMessage,
  parseTerraformPlan,
  summarizeByType,
} from "./notify-terraform-apply.mjs";

const samplePlan = `
Terraform will perform the following actions:

  # grafana_rule_group.oracle_stale_price will be updated in-place
  ~ resource "grafana_rule_group" "oracle_stale_price" {
      name = "Oracle stale price"
    }

  # grafana_contact_point.slack_alerts_oracles will be created
  + resource "grafana_contact_point" "slack_alerts_oracles" {
      name = "alerts-oracles"
    }

  # module.onchain_event_handler.google_cloudfunctions2_function.function must be replaced
  +/- resource "google_cloudfunctions2_function" "function" {
      name = "alerts-onchain-event-handler"
    }

  # module.onchain_event_listeners["celo"].data.http.webhook_filter will be read during apply
  <= data "http" "webhook_filter" {
      id = (known after apply)
    }

Plan: 2 to add, 1 to change, 1 to destroy.
`;

const parsed = parseTerraformPlan(samplePlan);

assert.deepEqual(parsed.counts, {
  add: 2,
  change: 1,
  destroy: 1,
});
assert.deepEqual(parsed.resourceActions, [
  {
    action: "update",
    address: "grafana_rule_group.oracle_stale_price",
    type: "grafana_rule_group",
  },
  {
    action: "create",
    address: "grafana_contact_point.slack_alerts_oracles",
    type: "grafana_contact_point",
  },
  {
    action: "replace",
    address:
      "module.onchain_event_handler.google_cloudfunctions2_function.function",
    type: "google_cloudfunctions2_function",
  },
]);

assert.deepEqual(summarizeByType(parsed.resourceActions), [
  {
    type: "google_cloudfunctions2_function",
    total: 1,
    actions: ["1 replace"],
  },
  {
    type: "grafana_contact_point",
    total: 1,
    actions: ["1 create"],
  },
  {
    type: "grafana_rule_group",
    total: 1,
    actions: ["1 update"],
  },
]);

assert.match(
  formatTypeSummary(parsed.resourceActions),
  /`grafana_rule_group`: 1 update/,
);
assert.match(
  formatResourceActions(parsed.resourceActions),
  /replace `module\.onchain_event_handler\.google_cloudfunctions2_function\.function`/,
);

assert.equal(
  parsePullRequestNumberFromCommitMessage(
    "Merge pull request #655 from mento-protocol/example",
  ),
  655,
);
assert.equal(
  parsePullRequestNumberFromCommitMessage("fix: order cleanup (#655)"),
  655,
);
assert.equal(parsePullRequestNumberFromCommitMessage("manual commit"), null);

const payload = buildSlackPayload({
  channel: "#ci-failures",
  stackLabel: "alerts/infra",
  targetEnvironment: "production",
  workflowName: "Alerts Infra",
  runNumber: "42",
  runUrl:
    "https://github.com/mento-protocol/monitoring-monorepo/actions/runs/1",
  commitUrl:
    "https://github.com/mento-protocol/monitoring-monorepo/commit/abcdef123",
  sha: "abcdef123",
  actor: "chapati23",
  trigger: "Push to main at abcdef1",
  pullRequest: {
    number: 655,
    title: "Archive <!channel> safely",
    url: "https://github.com/mento-protocol/monitoring-monorepo/pull/655",
  },
  parsedPlan: parsed,
});

assert.equal(payload.channel, "#ci-failures");
assert.equal(
  payload.text,
  "Terraform apply pending: alerts/infra (2 add, 1 change, 1 destroy)",
);
assert.match(
  JSON.stringify(payload.blocks),
  /#655 Archive &lt;!channel&gt; safely/,
);
assert.match(JSON.stringify(payload.blocks), /Resource addresses only/);

const payloadNoPr = buildSlackPayload({
  channel: "#ci-failures",
  stackLabel: "alerts<&>/rules",
  targetEnvironment: "production",
  workflowName: "Alerts Rules",
  runNumber: "7",
  runUrl:
    "https://github.com/mento-protocol/monitoring-monorepo/actions/runs/2",
  commitUrl:
    "https://github.com/mento-protocol/monitoring-monorepo/commit/abc1234",
  sha: "abc1234",
  actor: "chapati23",
  trigger: "Push to main at abc1234",
  pullRequest: null,
  parsedPlan: {
    counts: null,
    resourceActions: [],
  },
});

assert.equal(
  payloadNoPr.text,
  "Terraform apply pending: alerts&lt;&amp;&gt;/rules (changes detected)",
);
assert.equal(
  payloadNoPr.blocks[0].text.text,
  "Terraform apply pending: alerts&lt;&amp;&gt;/rules",
);
assert.match(JSON.stringify(payloadNoPr.blocks), /Push to main at abc1234/);
assert.equal(
  payloadNoPr.blocks
    .at(-1)
    .elements.some((element) => element.text?.text === "Open merged PR"),
  false,
);
assert.match(JSON.stringify(payloadNoPr.blocks), /changes detected/);

console.log("notify-terraform-apply tests passed");
