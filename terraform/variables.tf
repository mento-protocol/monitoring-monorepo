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

# ── Vercel Blob ───────────────────────────────────────────────────────────────

variable "blob_read_write_token" {
  description = <<-EOT
    Vercel Blob read-write token for the address-labels backup store.
    Required for daily backups to external storage (Vercel Blob, private access).
    Provision once with: vercel blob create-store address-labels --scope mentolabs
    Then copy the resulting token here.
  EOT
  type        = string
  sensitive   = true
}

# ── Google Cloud (metrics-bridge) ─────────────────────────────────────────────

variable "terraform_service_account" {
  description = "GCP service account to impersonate for Terraform operations."
  type        = string
  default     = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}

variable "gcp_project_id" {
  description = "GCP project ID for the monitoring project. Separate from mento-prod (Aegis)."
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
