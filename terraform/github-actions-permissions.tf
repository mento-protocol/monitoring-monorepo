# GitHub Actions default workflow-token permissions for `monitoring-monorepo`,
# managed by the platform stack.
#
# The repository's default `GITHUB_TOKEN` permission is pinned READ-ONLY here.
# Every workflow in this repo already declares explicit least-privilege
# `permissions:` (verified: no job falls through to the repo default), so this
# is behaviorally a no-op for existing workflows — it closes a DRIFT surface.
#
# Why it matters (issue #1557, found reviewing #1554): the autofix CI-trust
# checker (`scripts/check-autofix-ci-trust.mjs`) treats a job with no explicit
# `permissions:` as having no write scope (effectivePermissions=undefined ->
# hasWritePermission=false -> not flagged). That assumption is only sound when
# the REPO DEFAULT is read-only. The default was `write`, so a future
# no-`permissions` autofix-reachable job running `actions/checkout` would persist
# a write-scoped token the checker would NOT flag. Pinning the default to `read`
# makes the checker's assumption hold; drift back to `write` is caught by the
# terraform-drift plan (the "check fails on drift" of #1557's done-means).
#
# `can_approve_pull_request_reviews = false`: no workflow approves PRs via the
# automatic token (verified), so denying it is free least-privilege hardening.
#
# APPLY PREREQUISITE: this resource writes the repo's Actions permissions via
# `PUT /repos/{owner}/{repo}/actions/permissions/workflow`, which requires the
# provider PAT (`var.github_token`) to hold Repository -> Administration:
# Read/write (see `providers.tf`). The variables/secrets-only PAT cannot apply
# this — the operator must widen the PAT before the apply, or it 403s.
resource "github_workflow_repository_permissions" "default_read" {
  repository                       = "monitoring-monorepo"
  default_workflow_permissions     = "read"
  can_approve_pull_request_reviews = false
}
