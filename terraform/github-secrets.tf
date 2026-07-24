# GitHub repo Actions secrets managed by the platform stack.
#
# Vercel automation bypass secret
# ───────────────────────────────
#
# `.github/workflows/lighthouse.yml` runs against Vercel-Auth-protected
# preview deployments. To get past the SSO interstitial it needs the
# Protection Bypass for Automation secret as an `x-vercel-protection-bypass`
# header. Vercel rotates that secret periodically; before this stack
# managed it, the GitHub side was set manually via `gh secret set`, which
# silently drifted from Vercel whenever the secret was regenerated and
# broke every dashboard PR's Lighthouse gate until someone re-set it.
#
# Pinning the GitHub secret to the Terraform state of the Vercel project
# means every `terraform apply` reconciles drift — if Vercel rotates,
# `apply` updates GitHub; if GitHub drifts, `apply` overwrites it back.
#
# Scope: repo-level secret on `monitoring-monorepo` (not org-level). The
# only consumer is `.github/workflows/lighthouse.yml` in this repo, so an
# org secret would buy unnecessary blast radius and force the operator
# PAT to carry org-admin scope. Repo-level keeps the PAT narrow (Repository
# → Secrets: Read/write only) and matches the pattern `alerts/infra/`
# already uses for its `TF_VAR_*` mirrors.
#
# `count` gates this resource on `protection_bypass_for_automation` being
# enabled on the Vercel project. The documented rotation flow is "toggle
# off → apply → toggle on → apply"; during the brief "off" phase the
# bypass secret attribute is null, and an unconditional mirror would
# either fail the apply or push an empty value to GitHub. Letting the
# resource come and go with the bypass keeps both sides consistent — the
# Actions secret is absent precisely when there's no Vercel-side bypass
# to mirror. CI that depends on the secret will fail during the rotation
# window, which is the correct signal (don't run lhci against a project
# whose bypass is intentionally disabled).

resource "github_actions_secret" "vercel_automation_bypass" {
  # checkov:skip=CKV_GIT_4: `value` is plaintext intentionally. The
  # encrypted path (`data.github_actions_public_key` + libsodium-encrypted
  # `encrypted_value`) requires an external pipeline outside Terraform —
  # non-trivial complexity for marginal benefit here: state lives
  # encrypted at rest in the GCS backend, gated by the same
  # `terraform-service-account` impersonation that protects every other
  # sensitive value in this stack. Same trade-off applied in
  # `alerts/infra/main.tf` for the TF_VAR_* repo secrets. If/when the
  # threat model widens, swap to `encrypted_value`.
  count = vercel_project.dashboard.protection_bypass_for_automation ? 1 : 0

  repository  = "monitoring-monorepo"
  secret_name = "VERCEL_AUTOMATION_BYPASS_SECRET"
  value       = vercel_project.dashboard.protection_bypass_for_automation_secret
}

# Integration probes runtime secrets
# ───────────────────────────────────
#
# `.github/workflows/integration-probes.yml` uses these repo secrets to discover
# active Mento v3 pairs from the shared Envio endpoint, write the latest snapshot
# to the dashboard's Upstash database, and query keyed aggregator APIs without
# public rate-limit or edge-filter noise. Hasura and Upstash values are mirrored
# from the existing platform resources; aggregator keys come from the platform
# stack's gitignored `terraform.tfvars`, not from committed files. Keeping the
# mirrors here gives the same drift-reconciliation behavior as the Vercel bypass
# mirror: every platform apply reconciles the GitHub workflow runtime back to the
# Terraform-owned dashboard runtime.

resource "github_actions_secret" "integration_probe_hasura_url" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  repository  = "monitoring-monorepo"
  secret_name = "INTEGRATION_PROBES_HASURA_URL"
  value       = var.hasura_url
}

resource "github_actions_secret" "integration_probe_upstash_redis_rest_url" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  repository  = "monitoring-monorepo"
  secret_name = "UPSTASH_REDIS_REST_URL"
  value       = local.redis_rest_url
}

resource "github_actions_secret" "integration_probe_upstash_redis_rest_token" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  repository  = "monitoring-monorepo"
  secret_name = "UPSTASH_REDIS_REST_TOKEN"
  value       = upstash_redis_database.address_labels.rest_token
}

resource "github_actions_secret" "integration_probe_lifi_api_key" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.lifi_api_key == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "LIFI_API_KEY"
  value       = var.lifi_api_key
}

resource "github_actions_secret" "integration_probe_flytrade_api_key" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.flytrade_api_key == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "FLYTRADE_API_KEY"
  value       = var.flytrade_api_key
}

resource "github_actions_secret" "integration_probe_openocean_api_key" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.openocean_api_key == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "OPENOCEAN_API_KEY"
  value       = var.openocean_api_key
}

resource "github_actions_secret" "integration_probe_squid_integrator_id" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.squid_integrator_id == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "SQUID_INTEGRATOR_ID"
  value       = var.squid_integrator_id
}

# Sentry triage/autofix pipeline secrets
# ───────────────────────────────────────
#
# The staged Sentry triage/autofix pipeline (ADR 0036) runs entirely inside
# this repo's GitHub Actions. Two scheduled workflows —
# `.github/workflows/sentry-triage-ingest.yml` and
# `.github/workflows/sentry-triage-agent.yml`, added by sibling Phase-1 PRs —
# consume these two repo-level secrets:
#
#   - SENTRY_TRIAGE_TOKEN: a READ-ONLY Sentry internal-integration token
#     (scopes: Issue & Event Read, Project Read, Organization Read — NO write
#     scopes). Phase-1 triage is read-only by design; the investigating agent
#     treats Sentry payloads as untrusted input and holds no write credential
#     beyond commenting on its queue issue (ADR 0036 trust boundary). A
#     separate write-scoped token is minted only if/when Phase-2 auto-archive
#     is approved — do NOT widen this token's scopes here.
#   - CLAUDE_CODE_OAUTH_TOKEN: the Max-subscription OAuth token minted by
#     `claude setup-token`, used by `anthropics/claude-code-action@v1` in agent
#     mode. Inference-only; it carries no repo write capability of its own.
#     NOT a triage-only secret: it already exists live and is consumed by both
#     `.github/workflows/claude.yml` jobs (on-demand assistant + auto-review),
#     so the resource below ADOPTS a shared production credential — see its
#     lifecycle note.
#
# Both are `count`-gated on their tfvar being non-empty, exactly like the
# integration-probe aggregator keys above: plan and apply succeed while the
# values are unset, so this stack can merge and apply before the operator
# provisions the tokens. The pipeline stays inert until the tokens exist AND
# `github_actions_variable.sentry_triage_enabled` is flipped to "true" (see
# `github-variables.tf`). Human provisioning runbook:
# `docs/notes/sentry-triage-pipeline.md`.

# SENTRY_TRIAGE_TOKEN is brand-new: no live secret of this name exists and no
# workflow consumes it until the sibling Phase-1 PRs land, so plain count
# gating is enough — destroying it while unused breaks nothing, which is why
# it carries no `prevent_destroy` (asymmetric with
# `claude_code_oauth_token` below, which guards a shared live credential).
resource "github_actions_secret" "sentry_triage_token" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.sentry_triage_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "SENTRY_TRIAGE_TOKEN"
  value       = var.sentry_triage_token
}

# SENTRY_PROJECTION_TOKEN is brand-new (ADR 0038): a fine-grained GitHub PAT
# with Issues Read+Write on EXACTLY the three owning repos (frontend-monorepo,
# mento-analytics-api, minipay-dapp) and no other scope. The verdict-projection
# step in `.github/workflows/sentry-triage-agent.yml` is its ONLY consumer, and
# only for cross-repo issue create/search; the step no-ops gracefully while the
# secret is absent. Like `sentry_triage_token` above — and UNLIKE
# `claude_code_oauth_token` below — no live secret of this name exists and no
# external consumer depends on it, so plain `count` gating is enough and it
# carries NO `prevent_destroy`: destroying it while unused breaks nothing.
resource "github_actions_secret" "sentry_projection_token" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.sentry_projection_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "SENTRY_PROJECTION_TOKEN"
  value       = var.sentry_projection_token
}

# AUTOFIX_APP_PRIVATE_KEY is brand-new (ADR 0036 Phase 2b): the PEM private key
# of the `sentry-autofix` GitHub App. The autofix finalize step in
# `.github/workflows/sentry-autofix.yml` is its ONLY consumer, and only to mint
# a short-lived installation token for the fix-branch push + PR create (which is
# what makes required CI + Codex review fire, unlike a `github.token` push). Like
# `sentry_triage_token`/`sentry_projection_token` above — and UNLIKE
# `claude_code_oauth_token` below — no live secret of this name exists and no
# external consumer depends on it, so plain `count` gating is enough and it
# carries NO `prevent_destroy`: destroying it while unused breaks nothing.
resource "github_actions_secret" "autofix_app_private_key" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.autofix_app_private_key == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "AUTOFIX_APP_PRIVATE_KEY"
  value       = var.autofix_app_private_key
}

# SENTRY_ARCHIVE_TOKEN is brand-new (ADR 0036 Stage C, Phase 2a): a WRITE-scoped
# Sentry internal-integration token (Issue & Event: Read + Write, nothing else),
# consumed ONLY by `.github/workflows/sentry-triage-archive.yml` to set an issue
# to `archived_until_escalating`. Deliberately separate from the read-only
# `sentry_triage_token` (that token must never gain write scopes). Like
# `sentry_triage_token`/`sentry_projection_token` above — and UNLIKE
# `claude_code_oauth_token` below — no live secret of this name exists and no
# external consumer depends on it, so plain `count` gating is enough and it
# carries NO `prevent_destroy`: destroying it while unused breaks nothing.
resource "github_actions_secret" "sentry_archive_token" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.sentry_archive_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "SENTRY_ARCHIVE_TOKEN"
  value       = var.sentry_archive_token
}

# PLATFORM_SETTINGS_AUDIT_TOKEN is brand-new (issue #1564): a fine-grained GitHub
# PAT with Administration: Read on this repo only. Its ONLY consumer is
# `.github/workflows/platform-settings-drift.yml`, the daily check that the repo
# default workflow-token permission (pinned to `read` by
# `github_workflow_repository_permissions.default_read`, #1557) has not been
# reverted out-of-band. Read-only by design — it can never change a setting, and
# it is deliberately NOT the Administration:Read/Write `github_token` (which
# stays local-only, never a CI secret). Like `sentry_triage_token` above — and
# UNLIKE `claude_code_oauth_token` below — no live secret of this name exists and
# no external consumer depends on it, so plain `count` gating is enough and it
# carries NO `prevent_destroy`: destroying it while unused breaks nothing.
resource "github_actions_secret" "platform_settings_audit_token" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.platform_settings_audit_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "PLATFORM_SETTINGS_AUDIT_TOKEN"
  value       = var.platform_settings_audit_token
}

resource "github_actions_secret" "claude_code_oauth_token" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.claude_code_oauth_token == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "CLAUDE_CODE_OAUTH_TOKEN"
  value       = var.claude_code_oauth_token

  # This adopts an EXISTING live secret shared with `.github/workflows/
  # claude.yml` (the on-demand Claude assistant and the auto-review job both
  # read `secrets.CLAUDE_CODE_OAUTH_TOKEN`). Two hazards follow:
  #
  #   1. Adoption overwrite: GitHub secret writes are upserts, so the first
  #      apply with the tfvar set OVERWRITES the live value. The runbook
  #      (docs/notes/sentry-triage-pipeline.md) therefore requires putting a
  #      current working token — in practice a freshly minted
  #      `claude setup-token` value, since GitHub can't read secrets back —
  #      into tfvars, which rotates the token for claude.yml too.
  #   2. Destroy-on-empty: emptying the tfvar later would flip count 1→0 and
  #      destroy the live secret, silently breaking claude.yml.
  #      `prevent_destroy` turns that into a loud plan-time error instead.
  #      (Limitation: deleting this whole resource block removes the guard
  #      with it — Terraform then destroys the secret on the next apply.)
  #
  # While the tfvar is unset the resource has no state instance, so
  # `prevent_destroy` has nothing to act on and plans stay green — the count
  # gate and the guard compose cleanly.
  lifecycle {
    prevent_destroy = true
  }
}
