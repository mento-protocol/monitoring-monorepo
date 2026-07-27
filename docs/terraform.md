---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-07-26
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Terraform Stacks

`terraform.stacks.json` is the source of truth for Terraform roots; do not infer
ownership from directory names.

| Stack                 | Path                         | State prefix          | Owns                                                                                                                                                                                                                                                                    | Plan/apply policy                                                                                                   |
| --------------------- | ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `platform`            | `terraform/`                 | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, separated CI WIF/IAM identities, platform-owned repo Actions secrets/variables, and a dormant unapplied Peg-policy GCS source foundation | Manual plan; human-approved local apply                                                                             |
| `alerts-rules`        | `alerts/rules/`              | `alerts-rules`        | Protocol Grafana alert rules + Aegis service-health and testnet-health rule groups, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings                                                                                | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `alerts-delivery`     | `alerts/infra/`              | `alerts-infra`        | QuickNode webhooks, alert Cloud Functions, Sentry bridge, Slack channel lifecycle, Splunk On-Call rotation announcements, related GCP resources, and stack-local trusted-main refresh grants                                                                            | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `aegis`               | `aegis/terraform/`           | `aegis`               | Aegis Grafana dashboard and Aegis folder                                                                                                                                                                                                                                | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `governance-watchdog` | `governance-watchdog/infra/` | `governance-watchdog` | Dedicated governance-watchdog GCP project, Cloud Function/source archive, Secret Manager, QuickNode webhook creation, scheduler, monitoring, alerts, and stack-local trusted-main refresh grants                                                                        | PR plan; `main` apply through the `production-infra` GitHub Environment; daily drift plan via `terraform-drift.yml` |

## Commands

```bash
pnpm tf list
pnpm tf validate <stack-id>
pnpm tf plan <stack-id>
pnpm tf apply <stack-id> [--force-local-apply]
```

Existing aliases remain:

```bash
pnpm infra:plan
pnpm alerts:rules:plan
pnpm alerts:infra:plan
pnpm aegis:tf:plan
pnpm gov-watchdog:tf:plan
```

Without a stack, `pnpm tf validate` validates every registered stack. It formats
tracked and non-ignored untracked Terraform, then runs backend-free init and
validate. Gitignored operator `*.tfvars` stay outside that source check.

For stacks with `ci.apply == "push-main-production-infra-environment"`, local
apply requires a clean `main` at `origin/main` unless the operator deliberately
passes `--force-local-apply`. Normally, merge and let GitHub Actions apply
through `production-infra` approval.

## CI Model

`.github/workflows/infra.yml` uses coarse admission filters. The required
`.github/workflows/ci.yml` sentinel runs on every PR; its internal filter and
`scripts/tf-stacks.mjs` use the registry to validate changed stack roots. Until
[#1501](https://github.com/mento-protocol/monitoring-monorepo/issues/1501)
enforces parity, add each new `changedPathPatterns` entry to both workflow
filters too.

`alerts-rules`, `alerts-delivery`, `aegis`, and `governance-watchdog` have CI
apply behavior on `main`, gated by the `production-infra` GitHub Environment.
Plans can also run for workflow/notifier edits. Applies require stack-owned
deployment changes or maintainer `workflow_dispatch`. Platform remains manual.
`terraform-drift.yml` runs daily plan-only checks for all four stacks.
Trusted-`main` plans and drift use the read-only refresh chain, full refresh,
and `-lock=false`. Run
[#30212385280](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/30212385280)
proved that route for `alerts-delivery` and `governance-watchdog`. The legacy
routine-deployer Token Creator grant remains rollback-only until affected runs
drain and the read boundary is audited.

Eligible same-repo human PR plans use safe placeholder `TF_VAR_*` values or
guarded targets; fork, Dependabot, and `sentry-autofix/*` plans are skipped.
Trusted push/dispatch refresh and gated apply remain authoritative for
full-stack, third-party-provider, and secret-value diffs. Alerts-rules and
alerts-delivery PR plans are intentionally partial.
See [`docs/notes/terraform-secret-strategy-2026-07.md`](notes/terraform-secret-strategy-2026-07.md)
for the exact placeholder and target boundaries.

On `main`, the workflow posts a secretless Slack summary before approval.
Environment protection blocks the apply job, so the operator approves the
commit and earlier plan. Apply then creates and uses a later plan, leaving an
explicit drift window.

`Terraform Deploy Queue Watch` only warns after 60 minutes without a job start;
it never cancels or approves. Inspect the whole queue, cancel only an obsolete
predecessor, repeat approval if the plan creates the apply job later, and follow
every queued `main` run to terminal state. After apply, verify the live resource
and dispatch `terraform-drift.yml` from `main`. For manual-only platform repo
settings such as default workflow-token permission, dispatch
`platform-settings-drift.yml` instead. Channel routing lives in
[`docs/notes/slack-github-subscriptions.md`](notes/slack-github-subscriptions.md).

## Terraform CI identities

[ADR 0047](adr/0047-separated-terraform-ci-identities.md) owns the four lanes:
routine deploy, state-only same-repo PR plan, read-only trusted-`main` refresh,
and Environment-bound production apply. All three WIF providers bind repository
slug and immutable ID `1172025835`; apply also binds protected `main` and the
`production-infra` subject, while refresh uses an exact `workflow_ref`
allowlist. The identity contract restricts the four trusted-main plan workflows
and `terraform-drift.yml` to both refresh selectors.

Trusted-main plans use `-lock=false` and curated non-basic readers. Run
#30212385280 completed the required full-refresh proof; the run-drain and
read-boundary audits remain. Never add basic `roles/viewer`; limit object and
secret payload reads to state, deployment source, and managed secrets.

ADR 0047 also selects the final no-artifact apply contract: make a private plan
after approval, run fail-closed policy over its JSON, then apply those exact
bytes. Issue #1576 owns the dual-run migration. Until it lands, the current
apply-time re-plan and drift window remain in force.

## Identity bootstrap, routing cutover, and authority removal

The bootstrap, refresh routing, live full-refresh proof, legacy-authority
removal, run drain, and final IAM/WIF audit are complete. The Peg-policy foundation stays
source-only and unapplied until its own reviewed, human-approved platform plan
and apply. It creates no policy object and does not attach the runtime identity
to Cloud Run; policy publication and activation remain separate reviewed steps.

## Platform GitHub Actions secrets and variables

The manual-apply platform stack owns repository Actions mirrors in
`terraform/github-secrets.tf` and `terraform/github-variables.tf`. Clearing an
optional input can plan deletion; inspect each one. It also owns
`GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER`,
`GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT`,
`GCP_TERRAFORM_REFRESH_WORKLOAD_IDENTITY_PROVIDER`, and
`GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`. Workflows read these as `vars`; never
replace them with manual secrets or use the refresh selectors outside the four
registered trusted-main plan workflows and `terraform-drift.yml`.
Only `CLAUDE_CODE_OAUTH_TOKEN` currently has `prevent_destroy`; inspect every
planned mirror deletion.
Sentry credential routing lives in
[`docs/notes/sentry-triage-pipeline.md`](notes/sentry-triage-pipeline.md).

## GitHub Environments

Keep three managed Environments. `production-infra` has a required reviewer,
self-review allowed, admin bypass disabled, and protected-branch deployment; its
workflows verify that state before cloud auth. With one maintainer this is
operator acknowledgement, not independent or exact-plan review. [ADR
0029](adr/0029-ci-apply-production-infra-gate.md) records the decision against a
same-owner `CODEOWNERS` gate; revisit PR approval, latest-push approval, and
disabled Environment self-review when a second active maintainer exists.

`production-services` records routine deploys from protected `main` without a
reviewer.

`sentry-pipeline` (`terraform/github-environment.tf`, issue #1289,
[ADR 0050](adr/0050-environment-scoped-pipeline-secrets.md)) gates the Sentry
triage/autofix pipeline's exclusive secrets. It has a main-only
protected-branch deployment policy with admin bypass disabled
(`can_admins_bypass = false`, #1289 — an admin cannot silently dispatch an
off-main branch past the policy) and — deliberately, the pipeline is
unattended — no reviewer or wait timer. Unlike the other two it is
Terraform-managed; every platform apply reconciles its policy and secrets. Every secret-bearing Sentry job declares it, so those secrets are
reachable only from `main` — server-enforced even on a branch-modified
`workflow_dispatch`. `CLAUDE_CODE_OAUTH_TOKEN` intentionally stays repo-level
for `claude.yml`.

Never recreate retired `Production`/`production` names or manage
Environment secrets outside their owning IaC/integration path. A new workflow
reference can auto-create an unprotected Environment, so establish its
protection before merging the reference.

## Grafana Alert Ownership

The Aegis-to-alerts state migration is complete; do not rerun its import/state
removal procedure. Current ownership is:

- `alerts-rules` owns protocol rule groups, Aegis service-health and
  testnet-health rule groups, protocol folders, the global Grafana notification
  policy, contact points, message templates, and mute timings.
- `aegis` owns only the Aegis Grafana folder and Aegis dashboard.

Use each stack's maintained `terraform.tfvars.example` (or
`aegis/terraform/variables.tf`) instead of copying inputs from this overview.

Verify ownership and drift with:

```bash
terraform -chdir=alerts/rules state list | grep -E 'grafana_(rule_group|notification_policy|contact_point|message_template|mute_timing|folder)'
terraform -chdir=aegis/terraform state list | grep grafana_rule_group
pnpm alerts:rules:plan
pnpm aegis:tf:plan
```

Expected result: protocol rule groups, global routing resources,
`grafana_rule_group.aegis_service_alerts`, and
`grafana_rule_group.aegis_testnet_health` appear only in `alerts-rules`; the
`aegis` state contains only the Aegis folder + dashboard resources (the
`grep grafana_rule_group` against `aegis` returns nothing).
