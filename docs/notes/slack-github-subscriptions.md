---
title: GitHub-to-Slack notifications for Terraform-applying workflows
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: terraform/infra
review_interval_days: 30
garden_lane: operator-runbooks
---

# GitHub-to-Slack notifications for Terraform-applying workflows

Terraform deploy activity reaches Slack through three independent paths for the
CI-applied Terraform stacks (`alerts-rules`, `alerts-delivery`, `aegis`,
`governance-watchdog` — see `docs/terraform.md`). They are configured in
different places, and none should be treated as a substitute for the others.

## 1. GitHub Slack App subscription (Slack-side, NOT Terraform-managed)

The official GitHub Slack App posts a card for every subscribed workflow run
and — for a run that pauses on a GitHub Environment protection rule — an
in-Slack deployment approval prompt. The channel-subscription state is
configured inside Slack with the `/github` slash command; first use may require
authorizing Actions notifications, and an approver must be signed in and
authorized for the protected environment. There is no GitHub or Slack Terraform
provider resource for a channel's App subscriptions, so this **cannot** be
brought under IaC. This document is therefore the versioned record of what
should be subscribed and where — keep it in sync whenever someone runs
`/github subscribe`. See GitHub's
[Slack notification reference](https://docs.github.com/en/integrations/how-tos/slack/customize-notifications).

### The approval prompt comes from the `workflows` feature, filtered by name

The approval control for a `production-infra`-gated Terraform apply is
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
choice so a Slack outage never blocks a Terraform apply. A failed post remains
visible in the step logs and underlying outcome, but the continued step's
conclusion does not fail the plan job and there is no secondary alert. The
bot's `chat:write.public` OAuth scope lets it post to any _public_ channel
without being a member, so the default `#deploys` and any public reroute
target need no setup.

A **private** channel is the only case that needs the bot present, and there
is deliberately no Terraform resource for it: Slack's API cannot self-join a
private channel (`conversations.join` is public-only — a count-gated join
resource would be a no-op for public channels and fail outright for private
ones). If you point `TERRAFORM_APPLY_SLACK_CHANNEL` at a private channel,
`/invite` the bot to it once, manually.

### `TERRAFORM_APPLY_SLACK_CHANNEL` routing variable (IaC-managed)

The step reads `SLACK_CHANNEL` from `TERRAFORM_APPLY_SLACK_CHANNEL`, falling
back to `#deploys`. The workflows retain a compatibility guard that coerces
the retired `#ci-operations` value to `#deploys`, preventing an old variable
value from recreating a notification sink. This repository variable is managed
by the `platform` stack:
`terraform/variables.tf`'s `terraform_apply_slack_channel` (default `"#deploys"`)
feeds
`terraform/github-variables.tf`'s `github_actions_variable
.terraform_apply_slack_channel`. To reroute the notification, set the tfvar
and run `pnpm tf apply platform` (manual-apply stack, human-approved local
apply — see `docs/terraform.md`); if the new channel is private, `/invite`
the bot as above. The platform PAT needs **both** `Secrets: Read/write` and
`Variables: Read/write` — GitHub scopes repo Secrets and repo Variables
independently, so a Secrets-only PAT makes the
`github_actions_variable` resource fail with HTTP 403.

## 3. `Terraform Deploy Queue Watch`

`.github/workflows/terraform-deploy-queue-watch.yml` is the pre-plan detector for a
different failure mode: a post-merge Terraform deploy workflow can sit
`queued`/`pending` behind an older run before any job starts. In that state the
GitHub Slack App approval card and `scripts/notify-terraform-apply.mjs` summary
cannot fire because the deploy workflow has not reached its `plan` job.

The watcher runs daily, reads recent runs for the four `production-infra`
deploy workflows, and uses the same `TERRAFORM_APPLY_SLACK_CHANNEL` destination
and `#deploys` fallback as the apply-pending notifier steps. It also coerces the
retired `#ci-operations` value to `#deploys`.

It alerts when a `push`/`workflow_dispatch` run on `main` is older than 60
minutes, remains `queued`, `pending`, `requested`, or `waiting`, and still
has zero started jobs. It fails its own workflow run after posting so the
generic `#ci-failures` listener also has a machine-visible failure signal. It
is observer-only: it does not join the deploy workflows' `*-deploy`
concurrency groups, cancel runs, approve environments, or apply Terraform.

## Out of scope

`.github/workflows/notify-slack-on-main-failure.yml` is a separate Slack
integration for main-branch workflow _failures_ only, posted to `#ci-failures`
via the same bot token. It is only relevant here because the queue watcher is a
scheduled workflow and therefore must be listed in that listener's explicit
`workflow_run.workflows` allowlist.
