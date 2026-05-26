# Sentry Alerts Module

This module configures Sentry → **Slack** error monitoring for every project
in the `mento-labs` Sentry organization. Discord support was retired when the
team's alert taxonomy migrated to Slack; see `aegis/terraform/grafana-alerts/`
for the sibling Grafana → Slack setup.

## What it does

For each Sentry project (auto-discovered via `data "sentry_all_projects"`):

- **Default rule** → `#sentry-<project-slug>` on Slack. Fires on issue
  lifecycle events (first-seen / regression / reappeared) across all
  environments.
- **Critical fan-out** → `#alerts-critical` on Slack. Fires only when a fatal
  (`level = 50`) first-seen or regression event happens in `production`.
  Lands alongside Grafana page-grade alerts so on-call sees app errors in the
  same channel.

Both rules use the new `sentry_alert` supertype resource (introduced in
`jianyuan/sentry@0.15.0`) rather than the deprecated `sentry_issue_alert`.
The new resource is triggered by monitor lifecycle events, so it's
fundamentally less noisy than the old per-event firing model.

## Pre-flight (before terraform apply)

These steps happen outside Terraform and must be done first:

1. **Sentry Slack OAuth app installed** in the org — Sentry → Settings →
   Integrations → Slack. Without it, the `sentry_organization_integration`
   data source fails.
2. **"New Monitors and Alerts" feature enabled** in the Sentry org. The
   `sentry_alert` resource is in beta — if the feature isn't on for your
   org, rules apply via API but won't render in Sentry's web UI. Check the
   project Alerts page for a "Monitors" tab.
3. **6 Slack channels pre-created** (one per project), with the `@Sentry`
   OAuth bot invited:
   - `#sentry-analytics-api`
   - `#sentry-analytics-mento-org`
   - `#sentry-app-mento-org`
   - `#sentry-governance-mento-org`
   - `#sentry-minipay-dapp`
   - `#sentry-reserve-mento-org`
4. **`@Sentry` bot invited to `#alerts-critical`** — needed for the
   critical fan-out.
5. **Click-ops Sentry alert rules removed.** Any non-Terraform-managed rules
   pointing to Slack will fire in parallel and double-post — delete them in
   the Sentry UI before apply.

## Inputs

| Variable                      | Description                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| `sentry_organization_slug`    | Sentry org slug (e.g. `mento-labs`)                                |
| `sentry_team_slug`            | Sentry team slug                                                   |
| `sentry_slack_workspace_name` | Slack workspace name as shown in Sentry's Slack integration        |
| `slack_critical_channel`      | Override the critical fan-out channel (default `#alerts-critical`) |

## Resources Created

- `data.sentry_all_projects.all` — auto-discovers every Sentry project.
- `data.sentry_project_issue_stream_monitor.default[*]` — per-project default
  monitor IDs needed by `sentry_alert.monitor_ids`.
- `data.sentry_organization_integration.slack` — the Sentry-owned Slack OAuth
  integration; provides the `integration_id` used by the Slack action.
- `sentry_alert.slack_default[*]` — per-project default alert posting to
  `#sentry-<project-slug>`.
- `sentry_alert.slack_critical_fanout[*]` — per-project critical fan-out
  posting to `#alerts-critical` when `level = fatal` in `production`.

## Adding a new project

1. Create the project in Sentry (UI or API). Terraform does not manage
   project creation.
2. Have a Slack admin create the matching `#sentry-<project-slug>` channel
   and invite `@Sentry`.
3. Run `terraform apply` — the project is auto-discovered and both alert
   rules spin up.

## Removing a project

1. Delete the project in Sentry. Terraform won't delete projects.
2. Run `terraform apply` — auto-discovery drops the project from the
   `for_each` and both rules are destroyed. The Slack channel itself is not
   Terraform-managed; archive it manually if desired.

## Behavioral notes

- **`frequency_minutes = 5`** — Sentry will not re-fire an alert for the
  same issue within 5 minutes. This is the noise floor.
- **Threading** — the Sentry Slack OAuth app threads repeated events on the
  same issue into the original Slack message (since 2024-05-28 for issue
  alerts). Leaving threading enabled is essential for keeping the per-project
  channels readable.
- **Critical fan-out trigger choice** — uses `first_seen_event` and
  `regression_event` only. `reappeared_event` is excluded because we don't
  want unresolved-issue escalations to repeatedly page on-call; those should
  stay in the per-project channel.

## Rollback

`git revert <PR-SHA>` + `terraform apply` restores the prior Discord shape
within ~2 minutes (re-creates the Discord channels and the old
`sentry_issue_alert` resources). Loss window = the time between detecting a
Slack-delivery failure and the revert.
