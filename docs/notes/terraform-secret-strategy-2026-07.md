---
title: Terraform secret strategy hardening
status: active
owner: eng
last_verified: 2026-07-08
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

## Stack inventory

| Stack                 | Secret classes                                                                                                                                                                                                                             | PR plan posture                                                                                                                                      | Migration notes                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alerts-rules`        | Provider auth (`grafana_service_account_token`); configured contact-point/runtime values (`slack_bot_token`, `splunk_on_call_alerts_webhook_url`)                                                                                          | Full config-vs-state plan with placeholder TF_VARs and `-refresh=false`                                                                              | Grafana does not use GitHub OIDC. Keep PR secretless; trusted main/apply runs remain authoritative for refreshed provider truth.                                                                                                                                                              |
| `alerts-delivery`     | Provider auth (`sentry_auth_token`, `slack_bot_token`, `quicknode_api_key`, `github_token`); configured runtime secrets (`quicknode_signing_secret`, Splunk On-Call API values); non-secret IDs (`billing_account`, channel/usergroup IDs) | Targeted secretless PR plan for `module.onchain_event_handler` plus `terraform_data.pr_plan_secretless_guard`; full graph only on trusted main/apply | The Cloud Function target exercises a real runtime-secret surface without third-party provider auth. Sentry/Slack/QuickNode/GitHub resources still need authenticated plan-time checks, so keep the sentinel until the stack is split or those providers support safe dummy/no-auth planning. |
| `aegis`               | Provider auth (`grafana_service_account_token`)                                                                                                                                                                                            | Full config-vs-state plan with placeholder TF_VAR and `-refresh=false`                                                                               | Same Grafana posture as alerts-rules.                                                                                                                                                                                                                                                         |
| `governance-watchdog` | Provider auth (`github_token`, QuickNode API key); configured runtime secrets (Discord/Telegram/QuickNode/VictorOps/x-auth); non-secret IDs (`billing_account`, Slack notification channel ID)                                             | Full config-vs-state plan with placeholder TF_VARs and `-refresh=false`                                                                              | Uses Google/archive/local resources plus QuickNode/GitHub surfaces; placeholders keep same-repo PR jobs secretless. Trusted main/apply plans remain authoritative for secret values and refreshed remote state.                                                                               |

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
remote state, Workload Identity Federation, `org-terraform` impersonation, and
the `production-infra` environment gate. If provider schemas later expose
write-only alternatives for these exact resources, migrate one surface at a time
and update this note in the same PR.

## Next safe increments

Prefer small, reviewable hardening steps:

- Split `alerts-delivery` so Cloud Function/GCP resources and third-party SaaS
  provider resources can plan independently without sentinel targets.
- Move any provider that supports GitHub OIDC or dynamic credentials away from
  long-lived GitHub secrets.
- Replace state-stored secret resource arguments with write-only or ephemeral
  mechanisms where the provider supports them for the resources used here.

Do not broaden the read-only PR service account with project read permissions
just to recover full-refresh PR plans. That would make a PR-reachable identity
more powerful and is explicitly declined in
[`terraform-cicd-hardening-decisions-2026-05.md`](terraform-cicd-hardening-decisions-2026-05.md).
