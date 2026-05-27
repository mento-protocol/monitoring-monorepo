# GitHub org secret sourced from Vercel state.
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
# Visibility is scoped to `selected` + `monitoring-monorepo` only: the only
# consumer of this secret is `.github/workflows/lighthouse.yml` in this
# repo. Org-wide `"all"` visibility would let any workflow in any current
# or future repo bypass Vercel protection, which is a much wider blast
# radius than the use case justifies. If a new repo legitimately needs it,
# add its `repo_id` to `selected_repository_ids` below.
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

data "github_repository" "monitoring_monorepo" {
  full_name = "${var.github_owner}/monitoring-monorepo"
}

resource "github_actions_organization_secret" "vercel_automation_bypass" {
  # checkov:skip=CKV_GIT_4: `value` is plaintext intentionally. The
  # encrypted-value path (`data.github_actions_public_key` + libsodium-
  # encrypted `value_encrypted`) requires an external pipeline outside
  # Terraform — non-trivial complexity for marginal benefit here: state
  # lives encrypted at rest in the GCS backend, gated by the same
  # `terraform-service-account` impersonation that protects every other
  # sensitive value in this stack. Same trade-off applied in
  # `alerts/infra/main.tf` for the TF_VAR_* repo secrets. If/when the
  # threat model widens, swap to `value_encrypted`.
  count = vercel_project.dashboard.protection_bypass_for_automation ? 1 : 0

  secret_name             = "VERCEL_AUTOMATION_BYPASS_SECRET"
  visibility              = "selected"
  selected_repository_ids = [data.github_repository.monitoring_monorepo.repo_id]
  value                   = vercel_project.dashboard.protection_bypass_for_automation_secret
}
