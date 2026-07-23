---
title: Terraform secret strategy hardening
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: reference
scope: terraform/infra
review_interval_days: 90
garden_lane: package-readmes-reference
---

# Terraform Secret Strategy Hardening

This note records the current secret classification for Terraform CI after the
PR-plan secretless hardening work. It is intentionally operational: future
changes should update the table when a stack gains or loses a secret-bearing
provider, runtime secret, or repository/environment secret mirror.

## CI plan posture

Same-repo `pull_request` Terraform jobs must not receive production `TF_VAR_*`
secrets when they execute checked-out PR code. PR jobs use placeholder values
and read-only state access; trusted `push`, `workflow_dispatch`, and
`production-infra` apply jobs keep production secrets and re-plan before any
production mutation.

Never use `pull_request_target` to run Terraform against PR code. Never upload
binary `terraform plan -out` artifacts: Terraform plan files can include full
configuration, variable values, and sensitive values in cleartext even when
terminal output redacts them.

Machine-authored Sentry-autofix PRs (head branch `sentry-autofix/*`) are
excluded from every Terraform plan job outright (issue #1388): even the
placeholder/read-only PR posture is too much for them, because `terraform
plan` executes PR-head HCL (`data "external"` runs programs at plan time)
while the job holds the read-only plan SA — whose state-bucket
`storage.objectViewer` access includes cleartext secret values in state. The
autofix diff guard also forbids `*.tf`/`*.hcl`/`*.tfvars` at any depth;
the plan-job `if:` exclusion is defense in depth behind it, and
`scripts/check-autofix-ci-trust.mjs` enforces the pattern structurally.

## CI identity boundaries

[ADR 0047](../adr/0047-separated-terraform-ci-identities.md) keeps routine
service deploy, same-repo PR plan, trusted-main refresh, and production apply
on separate identities:

- Routine services use the general repository WIF provider and
  `metrics-bridge-deployer`. The final removal apply removes its ability to
  impersonate `org-terraform`.
- PR plans use the state-only plan chain. It receives neither project/service
  read roles nor live secret/object access.
- The separate cutover-routing PR routes trusted-main plans and scheduled drift
  through `vars.GCP_TERRAFORM_REFRESH_SERVICE_ACCOUNT`. The downstream
  `org-terraform-refresh-readonly` identity has state Object Viewer, a curated
  non-basic project read-role set, Secret Accessor on only Terraform-managed
  secrets, and Storage Object Viewer on only Cloud Function deployment-source
  buckets. The project-read core includes Browser, IAM Security Reviewer, and
  Storage Bucket Viewer; each owning stack enumerates its additional
  service-specific readers. That routing PR retains the legacy routine-deployer
  Token Creator grant until live proof and drain checks complete.
- Production applies select
  `vars.GCP_PRODUCTION_INFRA_WORKLOAD_IDENTITY_PROVIDER` and
  `vars.GCP_PRODUCTION_INFRA_SERVICE_ACCOUNT`. The dedicated pool accepts only
  the exact repository, protected `main` ref, and `production-infra`
  environment subject before the seed-project applier can impersonate
  `org-terraform`.

The refresh read bundle is a deliberate confidentiality tradeoff. Terraform's
pinned Google providers read managed Secret Manager payloads and deployment
source objects during a faithful refresh, and IAM resources require policy
visibility. Basic `roles/viewer` is forbidden because its `projectViewer`
convenience-group behavior grants legacy object reads on
uniform-bucket-level-access buckets. The exact Secret Accessor and Object Viewer
bindings exclude replay, rotation-state, and log bucket objects. The curated
service readers can still expose project-wide Cloud Logging entries, Monitoring
time series, and Artifact Registry contents. The complete bundle confers no
mutation permissions and is unreachable from PR refs.

After the cutover-routing PR lands, use its checked-in `main` route to run a
live full-refresh, unlocked plan (`-lock=false`, without `-refresh=false`) for
every CI-managed Google-provider stack; the current set is `alerts-delivery`
and `governance-watchdog`. Treat a provider 403 as a request to review one exact
read permission, not as justification for a basic role. Validation and an
IAM-grants-only plan do not prove the full resource graph can refresh or that
payload boundaries remain intact. Drain the pre-routing and proof runs and
audit the read boundary before a separate final removal PR deletes the legacy
Token Creator grant through an explicitly approved platform apply.

## Stack inventory

| Stack                 | Secret classes                                                                                                                                                                                                                             | PR plan posture                                                                                                                                              | Migration notes                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alerts-rules`        | Provider auth (`grafana_service_account_token`); configured contact-point/runtime values (`slack_bot_token`, `splunk_on_call_alerts_webhook_url`)                                                                                          | Targeted secretless PR plan for `terraform_data.pr_plan_secretless_guard` plus global-policy rule groups; full notification graph only on trusted main/apply | The PR plan now avoids live Grafana data-source reads by using audited static UIDs for externally owned folders. It still skips contact points, notification policies, and rule groups with direct `notification_settings`, because placeholder Slack/Splunk values would create bogus diffs.     |
| `alerts-delivery`     | Provider auth (`sentry_auth_token`, `slack_bot_token`, `quicknode_api_key`, `github_token`); configured runtime secrets (`quicknode_signing_secret`, Splunk On-Call API values); non-secret IDs (`billing_account`, channel/usergroup IDs) | Targeted secretless PR plan for `terraform_data.pr_plan_secretless_guard`; full graph only on trusted main/apply                                             | The handler module still depends on Slack channel outputs and placeholder-backed Secret Manager versions. Sentry/Slack/QuickNode/GitHub resources also need authenticated plan-time checks, so keep the sentinel until the stack is split or those providers support safe dummy/no-auth planning. |
| `aegis`               | Provider auth (`grafana_service_account_token`)                                                                                                                                                                                            | Full config-vs-state plan with placeholder TF_VAR and `-refresh=false`                                                                                       | Same secretless Grafana-token posture as alerts-rules, but this stack has no PR-plan Grafana data-source reads that force authentication before the diff. Re-check this assumption on Grafana provider major-version bumps.                                                                       |
| `governance-watchdog` | Provider auth (`github_token`, QuickNode API key); configured runtime secrets (Discord/Telegram/QuickNode/VictorOps/x-auth); non-secret IDs (`billing_account`, Slack notification channel ID)                                             | Full config-vs-state plan with placeholder TF_VARs and `-refresh=false`                                                                                      | Uses Google/archive/local resources plus QuickNode/GitHub surfaces; placeholders keep same-repo PR jobs secretless. Trusted main/apply plans remain authoritative for secret values and refreshed remote state.                                                                                   |

## Static external identifiers

Replacing live provider data-source reads with static external IDs can keep
same-repo PR plans secretless, but only when ownership is explicit. If the
referenced object is owned by another Terraform stack, pin the identifier in the
owning stack so destroy/recreate preserves the same ID. If the object is
external or not yet Terraform-managed, document that ownership next to the
static ID and verify the reference with a trusted or read-only plan before
shipping.

## Write-only and ephemeral support

Terraform `sensitive = true` only affects display. It does not remove values
from state or saved plans. When a provider exposes write-only arguments or
Terraform ephemeral value flows for the exact resource in use, prefer those over
storing secret material in state.

Current residual state exposure:

- Google Secret Manager version resources still use `secret_data` for Cloud
  Function runtime secrets.
- GitHub Actions secret resources still use provider-managed secret values for
  repo secret mirrors.
- Grafana, Sentry, Slack, QuickNode, and Splunk On-Call provider credentials are
  still required in trusted main/apply jobs.

Those values are accepted only on trusted paths and protected by encrypted
remote state, the separated Workload Identity Federation chains in ADR 0047,
and the `production-infra` environment gate. If provider schemas later expose
write-only alternatives for these exact resources, migrate one surface at a
time and update this note in the same PR.

## Next safe increments

Prefer small, reviewable hardening steps:

- Split `alerts-delivery` so Cloud Function/GCP resources, runtime Secret
  Manager versions, Slack channel outputs, and third-party SaaS provider
  resources can plan independently without sentinel targets.
- Continue expanding the `alerts-rules` PR target list only for rule groups that
  avoid direct `notification_settings` and secret-backed contact point
  dependencies. The first data-source refactor uses static external folder UIDs
  for Reserve and Aegis and targets the current global-policy rule groups.
- Move any provider that supports GitHub OIDC or dynamic credentials away from
  long-lived GitHub secrets.
- Replace state-stored secret resource arguments with write-only or ephemeral
  mechanisms where the provider supports them for the resources used here.

Do not broaden the read-only PR service account with project read permissions
just to recover full-refresh PR plans. The former full-refresh proposal was
reopened only for the separate trusted-main identity in ADR 0047; the
PR-reachable identity remains state-only. The historical decision and reopened
invariant are recorded in
[`terraform-cicd-hardening-decisions-2026-05.md`](terraform-cicd-hardening-decisions-2026-05.md).
