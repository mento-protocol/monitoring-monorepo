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
and — for a run that pauses on a GitHub Environment protection rule — an
in-Slack **Approve / Reject** button for the gated deployment. It is
configured entirely inside Slack with the `/github` slash command; there is
no GitHub or Slack Terraform provider resource for a channel's App
subscriptions, so this **cannot** be brought under IaC. This document is
therefore the versioned record of what should be subscribed and where — keep
it in sync whenever someone runs `/github subscribe`.

### The approval prompt comes from the `workflows` feature, filtered by name

The Approve/Reject button for a `production-infra`-gated Terraform apply is
surfaced by the App's **`workflows`** feature, not `deployments`. A bare
`/github subscribe … workflows` defaults to workflow runs on pull requests
against the default branch, which **misses** the push-triggered apply runs —
so the subscription must be a `name`+`event`+`branch` filter that lists each
gated workflow explicitly.

The four Terraform-apply workflows that gate on the `production-infra`
environment (and therefore emit an approval prompt) are:

| Workflow `name:`            | File                                        |
| --------------------------- | ------------------------------------------- |
| `Governance Watchdog Infra` | `.github/workflows/governance-watchdog.yml` |
| `Alerts Infra`              | `.github/workflows/alerts-infra.yml`        |
| `Alerts Rules`              | `.github/workflows/alerts-rules.yml`        |
| `Aegis Terraform`           | `.github/workflows/aegis-terraform.yml`     |

The `name` filter is a strict allowlist: a gated workflow **absent** from it
gets no card and no approval prompt — this is exactly what silently drops the
`Governance Watchdog Infra` and `Aegis Terraform` prompts when they are left
out. (`Aegis App Engine` and `Metrics Bridge` are also deploy workflows but
do **not** gate on `production-infra`; their cards are status-only, with no
approval button.)

Canonical subscription (run in the target channel, `#deploys`) —
all four gated workflows plus the two status-only deploy workflows:

```
/github subscribe mento-protocol/monitoring-monorepo workflows:{name:"Governance Watchdog Infra","Alerts Infra","Alerts Rules","Aegis Terraform","Aegis App Engine","Metrics Bridge" event:"push","workflow_dispatch" branch:"main"}
```

To audit the live filter, run `/github subscribe list features` in the
channel — that is the variant GitHub documents for showing a channel's active
subscription filters; plain `/github subscribe list` only names the
repositories the channel follows and will **not** print the `workflows:{…}`
string you need to reconcile. Its output detail has been inconsistent in
practice, so treat **this document** as the source of truth and reconcile the
live filter against it — not the other way around.

| Channel    | Subscription                     | Why                                                                                                                                                                      |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `#deploys` | the `workflows:{…}` filter above | Pairs with the apply-pending prompt (§2) so the plan summary, the `production-infra` approval prompt, and the final workflow-run outcome all land in the deploy channel. |

## 2. `scripts/notify-terraform-apply.mjs` (repo-owned, partially Terraform-managed)

A bespoke script invoked from a "Notify Slack that Terraform apply is
pending" step in the `plan` job of `governance-watchdog.yml`,
`aegis-terraform.yml`, `alerts-infra.yml`, and `alerts-rules.yml`. It parses
the sanitized plan output and posts a resource-action summary (add/change/
destroy counts, resource addresses, source PR) to Slack _before_ the
environment-gated apply job waits for `production-infra` approval —
independent of, and with no awareness of, the GitHub Slack App subscription
above.

### Channel membership

The step reads `env.SLACK_BOT_TOKEN` (`secrets.TF_VAR_SLACK_BOT_TOKEN`) and
posts via `chat.postMessage` under `continue-on-error: true` — a deliberate
choice so a Slack outage never blocks a Terraform apply, but it also means a
failed post is **silent** (the step shows green in the Actions UI even when
nothing reached Slack). The bot's `chat:write.public` OAuth scope lets it
post to any _public_ channel without being a member, so the default
`#deploys` and any public reroute target need no setup.

A **private** channel is the only case that needs the bot present, and there
is deliberately no Terraform resource for it: Slack's API cannot self-join a
private channel (`conversations.join` is public-only — a count-gated join
resource would be a no-op for public channels and fail outright for private
ones). If you point `TERRAFORM_APPLY_SLACK_CHANNEL` at a private channel,
`/invite` the bot to it once, manually.

### `TERRAFORM_APPLY_SLACK_CHANNEL` routing variable (IaC-managed)

The step reads `SLACK_CHANNEL: ${{ vars.TERRAFORM_APPLY_SLACK_CHANNEL ||
'#deploys' }}`. This repository variable is managed by the `platform`
stack: `terraform/variables.tf`'s `terraform_apply_slack_channel` (default
`"#deploys"`, preserving current behavior) feeds
`terraform/github-variables.tf`'s `github_actions_variable
.terraform_apply_slack_channel`. To reroute the notification, set the tfvar
and run `pnpm tf apply platform` (manual-apply stack, human-approved local
apply — see `docs/terraform.md`); if the new channel is private, `/invite`
the bot as above. The platform PAT needs **both** `Secrets: Read/write` and
`Variables: Read/write` — GitHub scopes repo Secrets and repo Variables
independently, so a Secrets-only PAT gets a silent 403 on the first apply.

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
