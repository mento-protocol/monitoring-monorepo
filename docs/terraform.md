---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Terraform Stacks

`terraform.stacks.json` is the machine-readable registry for Terraform roots.
Use it instead of inferring ownership from directory names.

| Stack                 | Path                         | State prefix          | Owns                                                                                                                                                                                                              | Plan/apply policy                                                                                                   |
| --------------------- | ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `platform`            | `terraform/`                 | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Alloy bootstrap, separated CI WIF/IAM identities, and platform-owned repo Actions secrets/variables | Manual plan; human-approved local apply                                                                             |
| `alerts-rules`        | `alerts/rules/`              | `alerts-rules`        | Protocol Grafana alert rules + Aegis service-health and testnet-health rule groups, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings                          | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `alerts-delivery`     | `alerts/infra/`              | `alerts-infra`        | QuickNode webhooks, alert Cloud Functions, Sentry bridge, Slack channel lifecycle, Splunk On-Call rotation announcements, related GCP resources, and stack-local trusted-main refresh grants                      | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `aegis`               | `aegis/terraform/`           | `aegis`               | Aegis Grafana dashboard and Aegis folder                                                                                                                                                                          | PR plan; `main` apply through the `production-infra` GitHub Environment                                             |
| `governance-watchdog` | `governance-watchdog/infra/` | `governance-watchdog` | Dedicated governance-watchdog GCP project, Cloud Function/source archive, Secret Manager, QuickNode webhook creation, scheduler, monitoring, alerts, and stack-local trusted-main refresh grants                  | PR plan; `main` apply through the `production-infra` GitHub Environment; daily drift plan via `terraform-drift.yml` |

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

`pnpm tf validate` without a stack validates all registered stacks. It checks
formatting for tracked and non-ignored untracked native Terraform sources, then
runs `terraform init -backend=false` and `terraform validate`. Gitignored
operator-held `*.tfvars` files are deliberately outside the source-format check.

For stacks where `terraform.stacks.json` declares
`ci.apply == "push-main-production-infra-environment"`, local
`pnpm tf apply <stack-id>` is guarded. It runs only when the checkout is on
`main`, the worktree is clean, and `HEAD == origin/main`, unless the operator
passes the deliberate override `--force-local-apply`. The expected safe path is
to merge to `main` and let GitHub Actions apply through the `production-infra`
Environment approval.

## CI Model

`.github/workflows/infra.yml` uses coarse YAML path filters to admit a run. The
required `.github/workflows/ci.yml` sentinel runs on every PR and routes
internally. Its change filter and `scripts/tf-stacks.mjs` use
`terraform.stacks.json` to classify changed stacks and validate only their
registered roots. The registry remains the ownership source of truth, but a new
`changedPathPatterns` entry must also reach the infra admission filter and the
CI internal filter until
[#1501](https://github.com/mento-protocol/monitoring-monorepo/issues/1501)
replaces that duplication with enforced parity.

`alerts-rules`, `alerts-delivery`, `aegis`, and `governance-watchdog` have CI
apply behavior on `main`, gated by the `production-infra` GitHub Environment.
Their plan jobs can run for workflow/notifier edits too, but the apply jobs only
become eligible when stack-owned deployment inputs changed or a maintainer used
`workflow_dispatch`. The platform stack remains manual-plan/manual-apply only.
`terraform-drift.yml` also runs a daily plan-only check for all four CI-applied
stacks. It never applies changes. During the identity bootstrap, its
Google-provider legs still authenticate through the legacy write-capable
deployer. A separate cutover-routing PR moves trusted-main plans and every
scheduled-drift leg to the refresh chain while retaining the legacy
write-capable path for rollback until live proof and drain checks complete.

Secret-bearing workflows use validation-safe placeholder `TF_VAR_*` values or
guarded targets for eligible same-repo human PR plans. Fork, Dependabot, and
`sentry-autofix/*` plans are skipped. Trusted push/dispatch plans and the
environment-gated apply jobs retain the real secrets and are authoritative for
full-stack, third-party-provider, and secret-value diffs. In particular,
alerts-rules and alerts-delivery PR plans are intentionally partial; do not
interpret them as full production plans.
See [`docs/notes/terraform-secret-strategy-2026-07.md`](notes/terraform-secret-strategy-2026-07.md)
for the exact placeholder and target boundaries.

For a real `main` plan, the workflow posts a secretless Slack action summary
before its apply waits for approval. `Terraform Deploy Queue Watch` warns when
a production Terraform workflow has had no job start for at least 60 minutes;
it observes only and never cancels or approves runs. Inspect the whole workflow
queue: cancel a predecessor only after confirming it is obsolete; otherwise let
its reconciliation finish. Approval given before the apply job existed may need
repeating after the plan creates that job. Follow every queued `main` run to a
terminal state because later runs can pass the gate without an obvious second
prompt. Never close drift from the first successful apply alone: verify the live
resource and dispatch `terraform-drift.yml` from `main`. Channel routing and
notification boundaries live in
[`docs/notes/slack-github-subscriptions.md`](notes/slack-github-subscriptions.md).

## Terraform CI identities

[ADR 0047](adr/0047-separated-terraform-ci-identities.md) separates four
authentication lanes. The identity-bootstrap PR creates the replacement
chains and switches production applies after its approved platform apply. A
separate cutover-routing PR switches trusted-main refresh/drift while retaining
the legacy routine-deployer impersonation grant. A final removal PR deletes
that grant only after live proof, queue drain, and IAM audit.

- Routine service workflows retain the general repository WIF provider and
  `metrics-bridge-deployer`. After the final removal apply, that identity has
  only its direct monitoring-project service-deploy roles and cannot
  impersonate `org-terraform`.
- Same-repo PR plans retain `metrics-bridge-plan-readonly` →
  `org-terraform-plan-readonly`. It can read unlocked Terraform state but has
  no live-project roles.
- The cutover-routing PR routes trusted-`main` plans and scheduled drift through
  `vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT` →
  `org-terraform-refresh-readonly`. It can read unlocked state, project
  and service metadata, IAM policies, only the Terraform-managed secret
  payloads, and only the Cloud Function deployment-source objects required for
  a faithful refresh. It has no write roles and is not reachable from PR refs.
  The identity-bootstrap workflows must not read this selector before that
  routing change lands.
- Apply jobs use
  `vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER` and
  `vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT`. The provider lives in a
  dedicated pool and accepts only the exact repository, `refs/heads/main`, and
  `production-infra` environment subject. Its seed-project applier can
  impersonate `org-terraform`.

The trusted-main read bundle is intentionally explicit. Alerts-delivery and
governance-watchdog grant a curated non-basic project read-role set for the
services each stack refreshes. Its guaranteed core is
`roles/browser`, `roles/iam.securityReviewer`, and
`roles/storage.bucketViewer`; the owning Terraform root enumerates any
additional service-specific read roles. Never substitute basic `roles/viewer`:
on uniform-bucket-level-access buckets its `projectViewer` convenience-group
membership also grants legacy object reads.

GCS object and Secret Manager payload access is separately scoped.
Alerts-delivery and governance-watchdog grant
`roles/secretmanager.secretAccessor` only on their Terraform-managed secrets
and `roles/storage.objectViewer` only on their function deployment-source
buckets. Replay, rotation-state, and log bucket objects remain outside the
refresh identity. Service-specific predefined readers can still expose
project-wide Cloud Logging entries, Monitoring time series, and Artifact
Registry contents. These reads expose IAM policy, service data, managed secret
payloads, and deployment source to trusted-main CI; that confidentiality cost
is accepted so drift refresh remains accurate without mutation authority.

Read-only plans pass `-lock=false`: state-bucket
`roles/storage.objectViewer` cannot create or delete the GCS lock object.

Terraform validation does not prove that this curated set can refresh the live
resource graph. After the cutover-routing PR lands, use its checked-in
trusted-main route to complete a live full-refresh, unlocked plan
(`-lock=false`, without `-refresh=false`) for every CI-managed Google-provider
stack. The current registry set is `alerts-delivery` and
`governance-watchdog`. Add permissions only in response to a concrete provider
denial; do not recover by granting a basic role. Inspect the resulting IAM
policies to confirm that object-payload access remains limited to the state and
deployment-source buckets and the explicitly managed secrets.

## Identity bootstrap, routing cutover, and authority removal

Use this order for the identity bootstrap, routing cutover, and final authority
removal:

1. Merge the PR, then cancel every infrastructure apply queued by that merge.
   Do not approve or reuse those runs because their repository variable
   context may predate the platform bootstrap.
2. From a clean current `main`, run `pnpm infra:plan`. Review it, obtain
   explicit approval, and run the local platform apply. This creates the
   dedicated production pool/provider, seed-project applier, trusted-main
   refresh chain, state access, and the three repository variables listed
   below.
3. Re-run the alerts-delivery and governance-watchdog `main` workflows. Review
   and approve their live-read-grant applies.
4. Verify the new production apply authentication path and final bootstrap
   grants. Keep the old routine deployer's Token Creator binding as a temporary
   rollback path.
5. Land a separate cutover-routing PR that routes trusted-main plans and
   scheduled drift through `vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`. This
   PR must retain the old Token Creator rollback grant.
6. Through that checked-in `main` route, run the live full-refresh, unlocked
   proof described above for every CI-managed Google-provider stack. Cancel
   superseded queued runs, drain every pre-routing and proof run to a terminal
   state, and audit the refresh grants and both remaining apply paths.
7. Only after step 6 succeeds, land a final removal PR that deletes the routine
   deployer's `org-terraform` Token Creator grant from the platform
   configuration. Cancel superseded runs and confirm that every infrastructure
   run has reached a terminal state. From clean current `main`, run and review
   `pnpm infra:plan`, obtain explicit approval, and apply the platform stack
   locally. Audit the final WIF and service-account IAM bindings after the
   apply.

Do not create a peg-policy GCP project or bucket before step 7 has been applied,
all queued and active infrastructure runs have drained, and the final IAM audit
confirms the legacy path is gone. While the routine deployer can still
impersonate `org-terraform`, it can inherit authority in a newly created project
and defeat the intended isolation. Create that project and bucket only in a
later reviewed change after final removal, drain, and audit.

## Platform GitHub Actions secrets and variables

The manual-apply platform stack owns repository Actions mirrors in
`terraform/github-secrets.tf` and `terraform/github-variables.tf`; values come
from platform resources or operator-held tfvars. Optional mirrors are
`count`-gated, so clearing an input can plan deletion. Review every planned
secret deletion: only `CLAUDE_CODE_OAUTH_TOKEN` currently has
`prevent_destroy`.

The platform stack owns these non-secret Terraform identity selectors:

- `GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER`;
- `GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT`;
- `GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`.

Workflows read them through the `vars` context. Do not replace them with
manually populated secrets or rename one side without updating every workflow,
Terraform resource, output, regression check, and this runbook in the same PR.
The bootstrap writes `GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`, but bootstrap
workflows must not consume it. Only the later cutover-routing PR may route
trusted-main plans and scheduled drift through that selector.

The Sentry triage, projection, autofix, and archive credentials and their three
kill switches are routed by
[`docs/notes/sentry-triage-pipeline.md`](notes/sentry-triage-pipeline.md). Keep
that runbook and the Terraform resources aligned rather than duplicating the
full inventory here.

## GitHub Environments

Keep exactly two production GitHub Environments for this repository:

- `production-infra`: used by Terraform apply jobs in `alerts-infra.yml`,
  `alerts-rules.yml`, `aegis-terraform.yml`, and `governance-watchdog.yml`.
  It must have required reviewers, self-review allowed for the required
  reviewer, administrator bypass disabled, and deployment branches limited to
  protected `main`. Terraform apply workflows verify this before cloud
  authentication and fail closed if protection drifts. Their dedicated WIF
  provider also requires the signed `production-infra` environment subject,
  exact repository, and protected `main` ref.
- `production-services`: used by routine service deploy jobs such as
  `metrics-bridge.yml` and `aegis-app-engine.yml`. Limit deployment branches to
  protected `main`, but leave required reviewers unset by default so green
  `main` deploys do not require an extra human approval.

Do not recreate the retired `Production`/`production` environments. GitHub can
auto-create an unprotected environment for a new workflow reference, so review
and create any future environment protection before merging that reference.

Never move or recreate environment secrets with CLI commands. Use the owning
IaC or documented owning integration; if neither exists, stop and establish an
IaC path before changing the secret.

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
