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

variable "hasura_url_multichain" {
  description = "GraphQL endpoint for the shared multichain Envio indexer (Celo + Monad). Both celo-mainnet and monad-mainnet networks query this single endpoint, filtered by chainId."
  type        = string
  default     = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql"
}

variable "hasura_url_celo_sepolia" {
  description = "GraphQL endpoint for the Celo Sepolia Envio indexer."
  type        = string
  default     = "https://indexer.hyperindex.xyz/fc3170d/v1/graphql"
}

variable "hasura_url_monad_testnet" {
  description = "GraphQL endpoint for the Monad Testnet Envio indexer. Leave empty until indexer is deployed."
  type        = string
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
  description = "GCP project ID for Cloud Run deployment. Separate from mento-prod (Aegis)."
  type        = string
  default     = "monitoring"
}

variable "gcp_region" {
  description = "GCP region for Cloud Run deployment."
  type        = string
  default     = "europe-west1"
}

variable "metrics_bridge_enabled" {
  description = "Whether to provision the metrics-bridge Cloud Run service. Set to true once the first image has been built."
  type        = bool
  default     = false
}

variable "metrics_bridge_image" {
  description = "Container image for the metrics bridge (e.g. europe-west1-docker.pkg.dev/monitoring/metrics-bridge/metrics-bridge:latest)."
  type        = string
  default     = ""

  validation {
    condition     = var.metrics_bridge_image == "" || can(regex("^[a-z]", var.metrics_bridge_image))
    error_message = "metrics_bridge_image must be a valid container image reference or empty string."
  }
}
