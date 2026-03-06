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

variable "hasura_url_sepolia_hosted" {
  description = "GraphQL endpoint for the hosted Celo Sepolia Envio indexer."
  type        = string
  default     = "https://indexer.hyperindex.xyz/fc3170d/v1/graphql"
}

variable "hasura_secret_sepolia_hosted" {
  description = "Admin secret for the Sepolia Hasura endpoint. Leave empty for public Envio-hosted deployments."
  type        = string
  sensitive   = true
  default     = ""
}

variable "hasura_url_mainnet_hosted" {
  description = "GraphQL endpoint for the hosted Celo Mainnet Envio indexer."
  type        = string
  default     = "https://indexer.hyperindex.xyz/60ff18c/v1/graphql"
}

variable "hasura_secret_mainnet_hosted" {
  description = "Admin secret for the Mainnet Hasura endpoint. Leave empty for public Envio-hosted deployments."
  type        = string
  sensitive   = true
  default     = ""
}

# ── Vercel Blob ───────────────────────────────────────────────────────────────

variable "blob_read_write_token" {
  description = <<-EOT
    Vercel Blob read-write token for the address-labels backup store.
    The Vercel Terraform provider does not support Blob store creation.
    Provision once with: vercel blob create-store address-labels --scope mentolabs
    Then copy the resulting token here.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}
