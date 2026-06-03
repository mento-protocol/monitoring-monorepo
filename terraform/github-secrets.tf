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

resource "github_actions_secret" "integration_probe_openocean_api_key" {
  # checkov:skip=CKV_GIT_4: Same state-backed plaintext trade-off as
  # `vercel_automation_bypass`; see the comment above for the threat model.
  count = var.openocean_api_key == "" ? 0 : 1

  repository  = "monitoring-monorepo"
  secret_name = "OPENOCEAN_API_KEY"
  value       = var.openocean_api_key
}
