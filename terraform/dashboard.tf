# ── Upstash Redis ─────────────────────────────────────────────────────────────

resource "upstash_redis_database" "address_labels" {
  database_name  = "address-labels"
  region         = "global"
  primary_region = var.upstash_region
  tls            = true
}

locals {
  # The Upstash provider may return just a hostname slug or a full URL.
  # Normalise to a full HTTPS URL before embedding in env vars.
  redis_rest_url = startswith(
    upstash_redis_database.address_labels.endpoint, "https://"
  ) ? upstash_redis_database.address_labels.endpoint : "https://${upstash_redis_database.address_labels.endpoint}"
}

# ── Vercel Project ────────────────────────────────────────────────────────────

resource "vercel_project" "dashboard" {
  name      = "monitoring-dashboard"
  framework = "nextjs"
  team_id   = var.vercel_team_id

  # Deploy from monorepo root so pnpm-lock.yaml is included in the upload.
  # Next.js is detected from ui-dashboard/ via root_directory.
  root_directory  = "ui-dashboard"
  install_command = "pnpm install"
  build_command   = "pnpm build"

  # The path-aware build skip lives in ui-dashboard/vercel.json so it can be
  # tested and reviewed with app changes.

  git_repository = {
    type              = "github"
    repo              = "mento-protocol/monitoring-monorepo"
    production_branch = "main"
  }

  # Enables the Protection Bypass for Automation feature so CI tooling
  # (Lighthouse, the Playwright INP gate, etc.) can audit Vercel-Auth-
  # protected preview deployments. Vercel generates a 32-char alphanumeric
  # secret exposed both as the `VERCEL_AUTOMATION_BYPASS_SECRET` system env
  # var on deployments and via the `protection_bypass_for_automation_secret`
  # computed attribute — `github-secrets.tf` mirrors that into the GitHub
  # org secret of the same name so `.github/workflows/lighthouse.yml` can
  # read it. To rotate: toggle this attribute off, apply, toggle back on,
  # apply. The next apply atomically rotates Vercel-side AND pushes the
  # new value to GitHub.
  protection_bypass_for_automation = true
}

# ── Environment Variables ─────────────────────────────────────────────────────

resource "vercel_project_environment_variable" "hasura_url" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL"
  value      = var.hasura_url
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "hasura_testnet_url" {
  count      = var.hasura_testnet_url == "" ? 0 : 1
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_HASURA_URL_TESTNET"
  value      = var.hasura_testnet_url
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "show_testnet_networks" {
  count      = var.show_testnet_networks ? 1 : 0
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "NEXT_PUBLIC_SHOW_TESTNET_NETWORKS"
  value      = "true"
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "redis_url" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "UPSTASH_REDIS_REST_URL"
  value      = local.redis_rest_url
  target     = ["production", "preview"]
}

resource "vercel_project_environment_variable" "redis_token" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "UPSTASH_REDIS_REST_TOKEN"
  value      = upstash_redis_database.address_labels.rest_token
  target     = ["production", "preview"]
  sensitive  = true
}

# `BLOB_READ_WRITE_TOKEN` was retired during the Vercel Blob OIDC cutover.
# Existing Terraform state referencing `vercel_project_environment_variable.blob_token`
# is cleared via this `removed` block. `destroy = false` keeps the state cleanup
# explicit and non-destructive if an older workspace still tracks the resource;
# the live dashboard project now gets `BLOB_STORE_ID` and
# `BLOB_WEBHOOK_PUBLIC_KEY` from the Vercel store integration instead.
removed {
  from = vercel_project_environment_variable.blob_token

  lifecycle {
    destroy = false
  }
}

# ── Auth Environment Variables ────────────────────────────────────────────
#
# SECURITY POSTURE — shared prod/preview AUTH_* values are intentional.
#
# The preview OAuth flow uses Auth.js's `redirectProxyUrl` (see auth.ts):
# Google callbacks land on the prod domain (the only whitelisted redirect URI
# in GCP), then proxy the session back to the preview origin. For that to
# work, `AUTH_SECRET` (which signs the state JWE and session JWTs) and
# the Google OAuth credentials MUST be identical on both targets — splitting
# them would break preview sign-in.
#
# Mitigating controls that make this acceptable:
#   1. Vercel Deployment Protection gates preview URLs to `mentolabs` team
#      SSO — only authorised team members can reach a preview in the first
#      place. (Verify in Vercel UI → Project Settings → Deployment Protection.)
#   2. Public PRs from forks are NOT deployed to preview by default for this
#      team (Vercel setting: Git → "Deploy for Fork Pull Requests" off).
#      If that setting is ever flipped on, these secrets become reachable to
#      untrusted contributors and MUST be rotated + scoped to production-only.
#   3. CRON_SECRET is explicitly scoped to production (see below).
#
# If the above controls are ever loosened, treat all three shared values as
# potentially exposed: rotate AUTH_GOOGLE_SECRET in GCP, regenerate AUTH_SECRET,
# then either (a) adopt a split-secret preview auth architecture (different
# OAuth client + domain-local state) or (b) drop preview app-auth entirely and
# rely on Vercel Deployment Protection alone (see commit 74e533f for the
# prior bypass pattern).
#
# Tracked: Codex finding 75f2920d (2026-04). Fix partial — CRON_SECRET has
# been scoped to production; AUTH_* sharing retained for the architectural
# reasons above.

resource "vercel_project_environment_variable" "auth_google_id" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_GOOGLE_ID"
  value      = var.auth_google_id
  # Shared prod+preview: see security posture comment above.
  target    = ["production", "preview"]
  sensitive = true
}

resource "vercel_project_environment_variable" "auth_google_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_GOOGLE_SECRET"
  value      = var.auth_google_secret
  # Shared prod+preview: see security posture comment above.
  target    = ["production", "preview"]
  sensitive = true
}

resource "vercel_project_environment_variable" "auth_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_SECRET"
  value      = var.auth_secret
  # Shared prod+preview: AUTH_SECRET signs the state JWE verified by the
  # redirectProxyUrl handshake — must match on both targets. See above.
  target    = ["production", "preview"]
  sensitive = true
}

resource "vercel_project_environment_variable" "cron_secret" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "CRON_SECRET"
  value      = var.cron_secret
  # Production-only: preview deployments do not run cron jobs and should not
  # have access to the backup trigger secret. This prevents a compromised
  # preview build from forging Bearer auth against the prod /backup endpoint.
  target    = ["production"]
  sensitive = true
}

# Arkham Intelligence API key for manual enrichment runs. Production-only so a
# compromised preview build can't burn the rate-limit budget. `count` guard
# skips creation when the key isn't provisioned; the Vercel schedule is disabled
# while access is unavailable.
resource "vercel_project_environment_variable" "arkham_api_key" {
  count      = var.arkham_api_key == "" ? 0 : 1
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "ARKHAM_API_KEY"
  value      = var.arkham_api_key
  target     = ["production"]
  sensitive  = true
}

# Dune Analytics API key for the MiniPay sync cron (production-only, mirrors
# the Arkham guardrails — preview builds shouldn't burn Dune query credits).
resource "vercel_project_environment_variable" "dune_api_key" {
  count      = var.dune_api_key == "" ? 0 : 1
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "DUNE_API_KEY"
  value      = var.dune_api_key
  target     = ["production"]
  sensitive  = true
}

# Preview auth proxy — routes Google OAuth through the prod domain (already
# whitelisted in GCP), then forwards the session back to the preview URL.
resource "vercel_project_environment_variable" "auth_redirect_proxy_url" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  key        = "AUTH_REDIRECT_PROXY_URL"
  value      = "https://monitoring.mento.org/api/auth"
  # Must be set on BOTH production and preview — Auth.js only enables proxy
  # mode when this var is present in the stable (prod) env too.
  # See: https://authjs.dev/getting-started/deployment#securing-a-preview-deployment
  target = ["production", "preview"]
}

# Cron jobs are defined in ui-dashboard/vercel.json and activated automatically
# on first deploy. No Terraform resource is needed.

# ── Custom Domain ────────────────────────────────────────────────────────────
# DNS is already pointing to Vercel (CNAME → vercel-dns). Assigning the domain
# to this project is all that's needed.

resource "vercel_project_domain" "monitoring" {
  project_id = vercel_project.dashboard.id
  team_id    = var.vercel_team_id
  domain     = "monitoring.mento.org"
}

# ── Local .vercel/project.json ────────────────────────────────────────────────
# Keeps the Vercel CLI linked to the correct project after creation/recreation.
# This file is gitignored but must exist locally for `vercel deploy` to work.

resource "local_file" "vercel_project_json" {
  content = jsonencode({
    projectId   = vercel_project.dashboard.id
    orgId       = var.vercel_team_id
    projectName = vercel_project.dashboard.name
  })
  filename        = "${path.module}/../.vercel/project.json"
  file_permission = "0644"
}
