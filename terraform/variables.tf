# ── Vercel ────────────────────────────────────────────────────────────────────

variable "vercel_token" {
  description = "Vercel API token. Create at vercel.com → Account Settings → Tokens."
  type        = string
  sensitive   = true
}

variable "vercel_team_id" {
  description = "Vercel team ID. Found in .vercel/project.json or team settings."
  type        = string
  default     = "team_4l4TPoxnWEcusT8VeXkHbzF2"
}

# ── GitHub ────────────────────────────────────────────────────────────────────
# Used to manage repo-level GitHub Actions secrets that belong to the platform
# stack, including the Vercel bypass mirror and integration-probe credentials.
# `alerts/infra/` uses a separate token of the same shape for its own `TF_VAR_*`
# repo-secret mirrors.

variable "github_owner" {
  description = "GitHub organization that owns the repo whose Actions secrets this stack manages."
  type        = string
  default     = "mento-protocol"
}

variable "github_token" {
  description = <<-EOT
    GitHub PAT for writing repository Actions secrets on
    `mento-protocol/monitoring-monorepo`. Fine-grained PAT scoped to that
    repo with Repository → Secrets: Read/write — least-privilege for this
    stack's use case (org-admin scope is NOT needed because the secrets
    managed here are repo-level, not org-level). Used only by
    `github_actions_secret` resources in this stack.
  EOT
  type        = string
  sensitive   = true
}

# ── Upstash ───────────────────────────────────────────────────────────────────

variable "upstash_email" {
  description = "Upstash account email. Found at console.upstash.com → Account → API Keys."
  type        = string
  sensitive   = true
}

variable "upstash_api_key" {
  description = "Upstash API key. Found at console.upstash.com → Account → API Keys."
  type        = string
  sensitive   = true
}

variable "upstash_region" {
  description = "Primary region for the Upstash Redis database."
  type        = string
  default     = "eu-west-1"

  validation {
    condition = contains([
      "us-east-1", "us-west-1", "us-west-2",
      "eu-central-1", "eu-west-1",
      "sa-east-1",
      "ap-southeast-1", "ap-southeast-2",
    ], var.upstash_region)
    error_message = "Must be a valid Upstash global region."
  }
}

# ── Hasura / Envio ────────────────────────────────────────────────────────────

variable "hasura_url" {
  description = "GraphQL endpoint for the shared Envio indexer."
  type        = string
  default     = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql"
}

# ── Integration Probes ────────────────────────────────────────────────────────

variable "openocean_api_key" {
  description = <<-EOT
    OpenOcean Pro API key for the scheduled integration-probes workflow.
    Mirrors into the repo-level Actions secret `OPENOCEAN_API_KEY`.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

# ── Auth (Google OAuth / NextAuth) ─────────────────────────────────────────

variable "auth_google_id" {
  description = "Google OAuth Client ID. Create at console.cloud.google.com → APIs & Services → Credentials."
  type        = string
  sensitive   = true
}

variable "auth_google_secret" {
  description = "Google OAuth Client Secret."
  type        = string
  sensitive   = true
}

variable "auth_secret" {
  description = "NextAuth.js secret for JWT encryption. Generate with: openssl rand -base64 32"
  type        = string
  sensitive   = true
}

variable "cron_secret" {
  description = "Shared secret for authenticating Vercel Cron requests to /api/address-labels/backup."
  type        = string
  sensitive   = true
}

# ── Arkham Intelligence ───────────────────────────────────────────────────────

variable "arkham_api_key" {
  description = <<-EOT
    Arkham Intelligence API key, used by the nightly /api/arkham/enrich
    cron to attach curated labels/entity attribution to Mento counterparty
    addresses. Apply for access at https://intel.arkm.com/api (gated).
    Server-side only — never exposed to the browser.
  EOT
  type        = string
  sensitive   = true
  # Default empty so `terraform apply` doesn't hard-fail before the team
  # has obtained a key. The Vercel env var resource below skips creation
  # when this is empty so the dashboard still deploys cleanly.
  default = ""
}

# ── Dune Analytics ────────────────────────────────────────────────────────────

variable "dune_api_key" {
  description = <<-EOT
    Dune Analytics API key, used by the nightly /api/minipay/sync cron to
    pull MiniPay attestations (Celo FederatedAttestations contract,
    issuer 0x7888...7fbc) into sharded `minipay:users:<nibble>` Redis SETs.
    The tagging cron then intersects these sets with Mento-interacting
    addresses and writes `source: minipay` labels. Generate at api.dune.com →
    Settings.
    Server-side only — never exposed to the browser.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

# ── Google Cloud (metrics-bridge) ─────────────────────────────────────────────

variable "terraform_service_account" {
  description = "GCP service account to impersonate for Terraform operations."
  type        = string
  default     = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}

variable "gcp_project_id" {
  description = "GCP project ID for the monitoring project."
  type        = string
  default     = "mento-monitoring"
}

variable "gcp_org_id" {
  description = "GCP organization ID. Find with: gcloud organizations list"
  type        = string
}

variable "gcp_billing_account" {
  description = "GCP billing account ID. Find with: gcloud billing accounts list"
  type        = string
  sensitive   = true
}

variable "gcp_region" {
  description = "GCP region for Cloud Run deployment."
  type        = string
  default     = "europe-west1"
}

variable "aegis_app_engine_location_id" {
  description = "App Engine location for Aegis and its Grafana Alloy collector. App Engine location is immutable once created; use us-central to preserve uc.r.appspot.com URLs."
  type        = string
  default     = "us-central"

  validation {
    condition     = var.aegis_app_engine_location_id == "us-central"
    error_message = "Aegis App Engine location must stay us-central unless the migration plan and all appspot URLs are updated."
  }
}

variable "metrics_bridge_image" {
  description = "Bootstrap image used only when the Cloud Run service is first created. After bootstrap, image rollouts happen out-of-band via `gcloud run services update` (see scripts/deploy-bridge.sh + the GitHub workflow) — terraform ignores image drift via `lifecycle.ignore_changes`. Pinned by digest so bootstrap behavior is deterministic across environments; `gcr.io/cloudrun/hello`'s `http.HandleFunc(\"/\", …)` catch-all handles the `/health` probe."
  type        = string
  default     = "gcr.io/cloudrun/hello@sha256:572cdac9c931d84f01557f445ad5e980f6f23860c9bb18af02f2d5ca0b3b101e"

  # Before this PR, passing `metrics_bridge_image = ""` was the documented way
  # to skip Cloud Run provisioning (via a `count` guard). That guard is gone;
  # an empty override now gets forwarded to `containers.image` and hard-fails
  # the apply. Reject the legacy empty value explicitly so the failure is a
  # clear variable error, not a downstream provider error.
  validation {
    condition     = length(var.metrics_bridge_image) > 0
    error_message = "metrics_bridge_image must not be empty. Omit the variable to use the bootstrap default, or pass a concrete image reference."
  }
}

variable "gcp_dev_members" {
  description = "IAM members who can deploy and manage the metrics-bridge service."
  type        = list(string)
  default     = ["group:eng@mentolabs.xyz"]
}
