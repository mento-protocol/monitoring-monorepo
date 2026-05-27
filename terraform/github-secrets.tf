# GitHub org secrets sourced from Vercel state.
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
# Visibility `all` mirrors how the secret was scoped before this stack
# took ownership (any repo in the org, including private CI repos, can
# consume it). Tighten to `selected` + an explicit repo list if the
# threat model ever requires it.

resource "github_actions_organization_secret" "vercel_automation_bypass" {
  # checkov:skip=CKV_GIT_4: `plaintext_value` is intentional. The encrypted-
  # value path (`data.github_actions_public_key` + libsodium-encrypted
  # `encrypted_value`) requires an external pipeline outside Terraform —
  # non-trivial complexity for marginal benefit here: state lives encrypted
  # at rest in the GCS backend, gated by the same `terraform-service-account`
  # impersonation that protects every other sensitive value in this stack.
  # Same trade-off applied in `alerts/infra/main.tf` for the TF_VAR_* repo
  # secrets. If/when the threat model widens, swap to `encrypted_value`.
  secret_name     = "VERCEL_AUTOMATION_BYPASS_SECRET"
  visibility      = "all"
  plaintext_value = vercel_project.dashboard.protection_bypass_for_automation_secret
}
