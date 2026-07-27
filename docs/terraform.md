---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-07-27
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Terraform Stacks

`terraform.stacks.json` is the source of truth for Terraform roots; do not infer
ownership from directory names.

| Stack                 | Path                         | State prefix          | Owns                                                                                                                                                                                                                                              | Plan/apply policy                                                                                                   |
| --------------------- | ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `platform`            | `terraform/`                 | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, explicit deploy-source buckets, separated CI WIF/IAM identities, and platform-owned repo Actions secrets/variables | Manual plan; human-approved local apply                                                                             |
| `alerts-rules`        | `alerts/rules/`              | `alerts-rules`        | Protocol Grafana alert rules + Aegis service-health and testnet-health rule groups, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings                                                          | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `alerts-delivery`     | `alerts/infra/`              | `alerts-infra`        | QuickNode webhooks, alert Cloud Functions, Sentry bridge, Slack channel lifecycle, Splunk On-Call rotation announcements, related GCP resources, and stack-local trusted-main refresh grants                                                      | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `aegis`               | `aegis/terraform/`           | `aegis`               | Aegis Grafana dashboard and Aegis folder                                                                                                                                                                                                          | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `governance-watchdog` | `governance-watchdog/infra/` | `governance-watchdog` | Dedicated governance-watchdog GCP project, Cloud Function/source archive, Secret Manager, QuickNode webhook creation, scheduler, monitoring, alerts, and stack-local trusted-main refresh grants                                                  | PR plan; `main` apply through the `production-infra` GitHub Environment; daily drift plan via `terraform-drift.yml` |

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

Alloy's full write-only input, IAM, deploy, and rollback contract lives in
[`aegis/grafana-agent/README.md`](../aegis/grafana-agent/README.md). Platform
plan/apply rejects unsafe logging, requires freshly fetched clean `main`, and
runs its verified snapshot with gitignored tfvars outside. Review the manual
plan and get explicit approval before apply; never seed via CLI or use
`--migrate`.

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

The bootstrap, refresh routing, and live full-refresh proof are complete.
Before merging the final-removal source, drain every pre-routing and proof run
and audit the read boundary. Source omission does not remove the live grant.

After merge, cancel superseded runs and wait for all infrastructure runs to
finish. Then plan from clean current `main`, apply only with explicit human
approval, and audit final IAM/WIF. Do not create the peg-policy project or
bucket until that apply, queue drain, and audit prove the legacy path is gone.

## Routine deployment source staging

[ADR 0053](adr/0053-explicit-deployment-source-staging.md) owns the source
upload boundary for routine GCP deploys. The platform stack creates:

- `mento-monitoring-cloud-build-source` in `var.gcp_region`, with a 7-day live
  object lifecycle;
- `mento-monitoring-app-engine-source` in `US`, with a 30-day live object
  lifecycle for App Engine's content-addressed source cache.

Both buckets use uniform access, enforced public-access prevention, disabled
soft-delete retention, `force_destroy = false`, and Terraform
`prevent_destroy`. Cloud Build callers can read bucket metadata and create
objects; the dedicated Alloy `grafana_agent_builder` can view those objects and
is also an App Engine uploader. App Engine uploaders have Object Admin only on
the App Engine source bucket because the CLI can replace or clean up cached
hash-named objects. AppSpot can view those objects. The routine deployer and
`gcp_dev_members` have Service Account User
only on Metrics Bridge's default Compute Engine service account, preserving the
automated and direct `pnpm bridge:deploy` Cloud Run paths after the broad
project-level fallback is removed.

The routing follow-up must move every checked-in `gcloud builds submit` to
`--gcs-source-staging-dir` and every checked-in `gcloud app deploy` to
`--bucket`. That follow-up also extends `pnpm tf:test` to discover these
executable surfaces and reject a new unflagged callsite.

The migration is deliberately additive. Merge the infrastructure-only PR,
refresh current `main`, run a clean current-main platform plan, get explicit
apply approval, apply, and verify the live buckets and IAM. Only then merge the
command-routing follow-up, whose merge triggers the automatic Metrics Bridge
and Aegis workflows. Canary Metrics Bridge, Aegis, and Alloy. Remove
project-wide Storage Admin and routine Service Account User only in the
separate post-canary phase, followed by an effective-IAM audit. Do not combine
that removal with peg-policy bucket or identity creation.

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

All three Environments are Terraform-managed in
`terraform/github-environment.tf` and restrict deployments with an **explicit
`main` branch pattern** (`custom_branch_policies = true` plus a
`github_repository_environment_deployment_policy`), never
`protected_branches = true`.

> **Use the branch pattern, not `protected_branches` (issue #1649).**
> `protected_branches = true` only admits branches covered by **classic** branch
> protection. This repo protects `main` with a **ruleset** and has no classic
> protection — `GET /repos/:o/:r/branches/main/protection` returns
> `404 Branch not protected` — so that policy matched nothing and **failed
> open**: off-main runs reached environment secrets. `GET .../branches/main`
> reporting `"protected": true` (rulesets count there, the deployment policy
> does not read it) is what made the broken config look correct. An explicit
> branch pattern does not depend on classic protection.
>
> `scripts/verify-github-environment-protection.mjs` enforces this shape before
> cloud auth, and reads the deployment-branch-policy allow-list itself so an
> empty or over-broad pattern set cannot pass.

`production-infra` has a required reviewer, self-review allowed, and admin
bypass disabled; its workflows verify that state before cloud auth. With one
maintainer this is operator acknowledgement, not independent or exact-plan
review. [ADR 0029](adr/0029-ci-apply-production-infra-gate.md) records the
decision against a same-owner `CODEOWNERS` gate; revisit PR approval,
latest-push approval, and disabled Environment self-review when a second active
maintainer exists. The reviewer rule is enforced independently of the branch
policy, so it held even while that policy was inert.

`production-services` records routine deploys from `main` without a reviewer.

`production-infra` and `production-services` were UI-managed until #1649. They
are bound to Terraform with an explicit state import — the identity contract
forbids top-level `import` blocks — before the first apply that owns them:

```bash
terraform -chdir=terraform import \
  github_repository_environment.production_infra monitoring-monorepo:production-infra
terraform -chdir=terraform import \
  github_repository_environment.production_services monitoring-monorepo:production-services
```

After importing, their plan must read `0 to add, N to change, 0 to destroy`. A
diff that drops `production-infra`'s `reviewers` would remove the production
apply gate — do not apply it.

`sentry-pipeline` (`terraform/github-environment.tf`, issue #1289,
[ADR 0050](adr/0050-environment-scoped-pipeline-secrets.md)) gates the Sentry
triage/autofix pipeline's exclusive secrets. It has the same `main`-only branch
pattern, admin bypass disabled, and — deliberately, the pipeline is unattended —
no reviewer or wait timer. Every platform apply reconciles its policy and
secrets. Every secret-bearing Sentry job declares it, so those secrets are
reachable only from `main`, server-enforced even on a branch-modified
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
