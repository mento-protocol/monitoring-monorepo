---
title: GitHub-to-Slack notifications for Terraform-applying workflows
status: active
owner: eng
last_verified: 2026-07-06
---

# GitHub-to-Slack notifications for Terraform-applying workflows

Two independent systems post GitHub Actions activity into Slack for the
CI-applied Terraform stacks (`alerts-rules`, `alerts-delivery`, `aegis`,
`governance-watchdog` — see `docs/terraform.md`). They are unrelated,
configured in different places, and neither can see the other.

## 1. GitHub Slack App subscription (Slack-side, NOT Terraform-managed)

The official GitHub Slack App posts a card for every subscribed workflow run
and deployment status change. It is configured entirely inside Slack with
the `/github` slash command — there is no GitHub or Slack Terraform provider
resource for a channel's App subscriptions, so this **cannot** be brought
under IaC. This document is therefore the versioned record of what should be
subscribed and where; keep it in sync whenever someone runs `/github
subscribe` or `/github unsubscribe`.

Commands:

```
/github subscribe mento-protocol/monitoring-monorepo workflows deployments
/github subscribe list
/github unsubscribe mento-protocol/monitoring-monorepo <feature>
```

`/github subscribe list` (run in the target channel) shows the live feature
flags currently subscribed there — treat it as the audit command, and update
the table below when it disagrees.

| Channel          | Command run                                                                  | Features                   | Why                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#ci-operations` | `/github subscribe mento-protocol/monitoring-monorepo workflows deployments` | workflow runs, deployments | Pairs with the apply-pending prompt below (§2) so the plan summary, the `production-infra` approval wait, and the final workflow-run outcome all land in the same channel. |

Important: the GitHub Slack App does **not** provide an in-Slack "approve"
button for GitHub Environment approvals — it only posts status cards.
Approving a `production-infra`-gated apply job still requires the GitHub web
UI or mobile app (see `docs/terraform.md` → GitHub Environment Setup).

## 2. `scripts/notify-terraform-apply.mjs` (repo-owned, partially Terraform-managed)

A bespoke script invoked from a "Notify Slack that Terraform apply is
pending" step in the `plan` job of `governance-watchdog.yml`,
`aegis-terraform.yml`, `alerts-infra.yml`, and `alerts-rules.yml`. It parses
the sanitized plan output and posts a resource-action summary (add/change/
destroy counts, resource addresses, source PR) to Slack _before_ the
environment-gated apply job waits for `production-infra` approval —
independent of, and with no awareness of, the GitHub Slack App subscription
above.

### Bot-invite requirement

The step reads `env.SLACK_BOT_TOKEN` (`secrets.TF_VAR_SLACK_BOT_TOKEN`) and
posts via `chat.postMessage`, then runs with `continue-on-error: true` — a
deliberate choice so a Slack outage never blocks a Terraform apply, but it
also means a failed post is **silent**: the step shows green in the Actions
UI even when nothing reached Slack. `chat:write.public` (one of the bot's
OAuth scopes) lets it post to any _public_ channel without being a member,
but that scope does not help for a private channel, or in the rare case the
bot's `chat:write.public` grant itself lapses. Whenever
`TERRAFORM_APPLY_SLACK_CHANNEL` (below) is pointed at a channel the bot has
not otherwise joined, add the channel's ID to `deploy_notification_channel_id`
in `alerts/infra/terraform.tfvars` (see `alerts/infra/deploy-notification-channel.tf`)
so an `alerts-delivery` apply joins the bot to it via IaC, instead of relying
on someone remembering to `/invite` it manually.

### `TERRAFORM_APPLY_SLACK_CHANNEL` routing variable (now IaC-managed)

The step reads `SLACK_CHANNEL: ${{ vars.TERRAFORM_APPLY_SLACK_CHANNEL ||
'#ci-operations' }}`. This repository variable is now managed by the
`platform` stack: `terraform/variables.tf`'s `terraform_apply_slack_channel`
(default `"#ci-operations"`, preserving current behavior) feeds
`terraform/github-variables.tf`'s `github_actions_variable
.terraform_apply_slack_channel`. To reroute the notification, set the tfvar
and run `pnpm tf apply platform` (manual-apply stack, human-approved local
apply — see `docs/terraform.md`), then, if the new channel is private or the
bot isn't already a member, set `deploy_notification_channel_id` in
`alerts/infra/terraform.tfvars` and let the `alerts-delivery` stack's
CI-apply-on-merge pick it up.

## Known hazard: stalled deploy runs

Neither notification system fires while a deploy workflow run is stuck
`queued`/`pending` with zero started jobs — the plan job that posts both
notifications never runs. See issue #1136 for the concurrency-pileup hazard
and proposed stuck-run visibility fixes; this is tracked separately and not
addressed by this document.

## Out of scope

`.github/workflows/notify-slack-on-main-failure.yml` is a third, separate
Slack integration (main-branch workflow _failures_ only, posted to
`#ci-failures` via the same bot token) — it is not one of the two systems
described above and is not covered by this document.
