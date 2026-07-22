<!-- agent-context: title="Sentry Alerts Module" status=active owner=eng canonical=true last_verified=2026-07-17 doc_type=runbook scope=alerts/infra/channels/sentry-bridge review_interval_days=90 garden_lane=operator-runbooks -->

# Sentry Alerts Module

Terraform-managed Sentry-to-Slack error monitoring for every project discovered
in the `mento-labs` Sentry organization. See [`alerts/rules`](../../../rules/)
for the sibling Grafana-to-Slack setup.

## Behavior

For each Sentry project, the module creates:

- a default rule posting first-seen, regression, and reappeared issue events
  from every environment to `#sentry-<project-slug>`; and
- a critical fan-out rule posting fatal first-seen and regression events from
  `production` to `#alerts-critical`.

Both rules use the `sentry_alert` supertype. The stack is currently pinned to
`jianyuan/sentry@0.15.0-beta3`; stable `0.15.4` is tracked separately in
[#1472](https://github.com/mento-protocol/monitoring-monorepo/issues/1472) so
the provider and lockfile change receive an authenticated drift review.

## Preflight

Before planning:

1. Confirm the Sentry Slack OAuth integration is installed for the organization.
2. Confirm every discovered project exposes the default issue-stream monitor
   used by `data.sentry_project_issue_stream_monitor.default`. A missing monitor
   makes the whole `for_each` plan fail.
3. Provide the separate Slack bot token used for channel lifecycle with
   `channels:read`, `channels:manage`, and `channels:join` scopes.
4. Confirm `#alerts-critical` exists and the Sentry integration can post to it.
   Invite the integration explicitly when the channel is private.
5. Inventory any click-ops alert rules that would duplicate the managed rules.
   Do not delete them before a successful plan. Apply and verify the managed
   replacement first, then retire duplicates with explicit approval.

The module creates `#sentry-<project-slug>` channels. Import an existing channel
rather than allowing `conversations.create` to fail with `name_taken`.

## Inputs

| Variable                      | Description                                                |
| ----------------------------- | ---------------------------------------------------------- |
| `sentry_organization_slug`    | Sentry organization slug                                   |
| `sentry_slack_workspace_name` | Workspace name exposed by Sentry's Slack integration       |
| `slack_critical_channel`      | Critical fan-out channel name (default `#alerts-critical`) |
| `slack_critical_channel_id`   | Matching Slack channel ID for the critical fan-out         |

## Managed resources

- `data.sentry_all_projects.all` discovers Sentry projects.
- `data.sentry_project_issue_stream_monitor.default[*]` resolves their default
  monitor IDs.
- `data.sentry_organization_integration.slack` resolves the Sentry-owned Slack
  OAuth integration.
- `restapi_object.sentry_slack_channel[*]` creates and archives the per-project
  public channels.
- `restapi_object.sentry_slack_channel_member[*]` joins the bot so archival is
  authorized; the join operation is idempotent.
- `sentry_alert.slack_default[*]` and
  `sentry_alert.slack_critical_fanout[*]` own the two alert rules per project.

## Import an existing channel

After explicit approval for the state mutation, import from the repository
root using the project slug and Slack channel ID:

```bash
terraform -chdir=alerts/infra import \
  'module.sentry_bridge.restapi_object.sentry_slack_channel["analytics-api"]' \
  C0123ABC456
```

The channel-member resource joins the bot during the next gated apply; a manual
Slack invite is not required for the Terraform bot.

## Add or remove a Sentry project

Sentry owns project creation and deletion. Its project list automatically
changes this module's `for_each` set.

1. Create or delete the project in Sentry.
2. For a new project, wait until its default issue-stream monitor is visible.
3. Run `pnpm alerts:infra:plan` and review the proposed rule and Slack channel
   lifecycle changes.
4. If this is an external-only Sentry change with no repository diff, dispatch
   `.github/workflows/alerts-infra.yml` from `main`, review its plan, and approve
   the `production-infra` environment. If repository configuration also changes,
   use the normal reviewed PR and merge-triggered apply instead.
5. Verify rule evaluation and Slack delivery before retiring duplicate
   click-ops rules or purging an archived channel.

Manual dispatch is the normal reconciliation path for Sentry-only discovery
drift and a recovery path for the stack. It must run from `main`; do not use it
to deploy unreviewed repository configuration.

## Operational notes

- `frequency_minutes = 5` prevents the same issue rule from re-firing within
  five minutes.
- The critical fan-out intentionally excludes `reappeared_event`; repeated
  unresolved-issue notifications stay in the per-project channel.
- Slack channels are archived, not deleted, when their Terraform resource is
  destroyed.

## Removing Terraform channel ownership

A change that removes `restapi_object.sentry_slack_channel` would archive every
managed `#sentry-<slug>` channel. Before merging such a change, inspect the full
plan and decide explicitly whether archival is intended.

If channel history and routing must remain while Terraform ownership is
removed, obtain approval for a state-aware recovery, remove only the approved
channel resources from state, re-plan, and merge the reviewed change through
the protected workflow. Do not use a targeted local apply or patch alert
routing out of band. If the plan still destroys rules or channels unexpectedly,
stop rather than accepting the churn.
