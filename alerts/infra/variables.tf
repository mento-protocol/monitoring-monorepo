# For consistency we also keep this variable in here, although it's not used in the Terraform code (only in the shell scripts)
variable "terraform_service_account" {
  type        = string
  description = "Service account of our Terraform GCP Project which can be impersonated to create and destroy resources in this project"
  default     = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}

# For consistency we also keep this variable in here, although it's not used in the Terraform code (only in the shell scripts)
variable "terraform_seed_project_id" {
  type        = string
  description = "The GCP Project ID of the Terraform Seed Project housing the terraform state of all projects"
  default     = "mento-terraform-seed-ffac"
}
#####################
# Sentry Variables
#####################

variable "sentry_auth_token" {
  description = "Sentry authentication token"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.sentry_auth_token) > 20
    error_message = "Sentry auth token must be a valid token string."
  }
}

variable "sentry_organization_slug" {
  description = "Sentry organization slug (from URL: https://[slug].sentry.io)"
  type        = string
  default     = "mento-labs"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.sentry_organization_slug))
    error_message = "Sentry organization slug must contain only lowercase letters, numbers, and hyphens."
  }
}

variable "sentry_slack_workspace_name" {
  description = "Slack workspace name as it appears in Sentry's Slack integration (Settings → Integrations → Slack). Case-sensitive."
  type        = string
  default     = "Mento Labs"
}

variable "sentry_slack_critical_channel" {
  description = "Slack channel name (with leading #) that receives the fatal-first-seen/regression critical fan-out from every Sentry project. Defaults to #alerts-critical to land alongside Grafana page-grade alerts."
  type        = string
  default     = "#alerts-critical"

  validation {
    condition     = can(regex("^#", var.sentry_slack_critical_channel))
    error_message = "sentry_slack_critical_channel must start with '#' (e.g. '#alerts-critical')."
  }
}

variable "sentry_slack_critical_channel_id" {
  description = "Slack channel ID for sentry_slack_critical_channel. Must be updated with sentry_slack_critical_channel when rerouting critical fan-out."
  type        = string
  default     = "C0AURREPNDU"

  validation {
    condition     = can(regex("^[CG][A-Z0-9]{8,}$", var.sentry_slack_critical_channel_id))
    error_message = "sentry_slack_critical_channel_id must be a Slack channel ID such as C0AURREPNDU."
  }

  validation {
    condition = (
      (
        var.sentry_slack_critical_channel == "#alerts-critical"
        && var.sentry_slack_critical_channel_id == "C0AURREPNDU"
      )
      || (
        var.sentry_slack_critical_channel != "#alerts-critical"
        && var.sentry_slack_critical_channel_id != "C0AURREPNDU"
      )
    )
    error_message = "sentry_slack_critical_channel and sentry_slack_critical_channel_id must be changed together when rerouting critical fan-out."
  }
}

variable "slack_bot_token" {
  description = "Slack bot OAuth token (xoxb-...) used by the restapi.slack provider to create + archive alert channels and by the on-chain event handler to post via chat.postMessage. Needs scopes: channels:read, channels:manage, channels:join, chat:write. SEPARATE from Sentry's own Slack OAuth app — Sentry posts via its own integration."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.slack_bot_token, "xoxb-")
    error_message = "slack_bot_token must be a Slack bot OAuth token starting with 'xoxb-'."
  }
}

#####################
# Blockchain Configuration
#####################
# NOTE: This deployment creates ONE central GCP project that handles alerts
# for multiple chains. The multisigs can be from different chains, and the
# cloud function will route alerts appropriately based on the webhook source.

#####################
# Multisig Configuration
#####################

variable "multisigs" {
  description = "Map of multisig configurations to monitor. Can include multisigs from multiple chains."
  type = map(object({
    name                   = string
    address                = string
    chain                  = string # e.g., "celo", "ethereum", "base"
    quicknode_network_name = string # QuickNode network identifier (e.g., "celo-mainnet", "ethereum-mainnet")
  }))
  default = {
    "mento-labs-celo" = {
      name                   = "Mento Labs Multisig"
      address                = "0x655133d8E90F8190ed5c1F0f3710F602800C0150"
      chain                  = "celo"
      quicknode_network_name = "celo-mainnet"
    }
    "reserve-celo" = {
      name                   = "Reserve Multisig"
      address                = "0x87647780180B8f55980C7D3fFeFe08a9B29e9aE1"
      chain                  = "celo"
      quicknode_network_name = "celo-mainnet"
    }
    "mento-labs-eth" = {
      name                   = "Mento Labs Multisig"
      address                = "0xaB125CcB7660b717fc3A1df5d04Ac4cFC3558d8A"
      chain                  = "ethereum"
      quicknode_network_name = "ethereum-mainnet"
    }
    "mento-protocol-foundation-celo" = {
      name                   = "Mento Protocol Foundation"
      address                = "0x3468D23A0B1aB3Ab9A537813166A8f7ff1947014"
      chain                  = "celo"
      quicknode_network_name = "celo-mainnet"
    }
    "mento-protocol-foundation-eth" = {
      name                   = "Mento Protocol Foundation"
      address                = "0x3468D23A0B1aB3Ab9A537813166A8f7ff1947014"
      chain                  = "ethereum"
      quicknode_network_name = "ethereum-mainnet"
    }
    "reserve-eth" = {
      name                   = "Reserve Multisig"
      address                = "0xd0697f70E79476195B742d5aFAb14BE50f98CC1E"
      chain                  = "ethereum"
      quicknode_network_name = "ethereum-mainnet"
    }
    "reserve-ops-celo" = {
      name                   = "Reserve Ops Multisig"
      address                = "0xD3D2e5c5Af667DA817b2D752d86c8f40c22137E1"
      chain                  = "celo"
      quicknode_network_name = "celo-mainnet"
    }
    "reserve-ops-eth" = {
      name                   = "Reserve Ops Multisig"
      address                = "0xD3D2e5c5Af667DA817b2D752d86c8f40c22137E1"
      chain                  = "ethereum"
      quicknode_network_name = "ethereum-mainnet"
    }
    "mento-watchdog-celo" = {
      name                   = "Mento Watchdog"
      address                = "0xE6951C4176aaB41097C6f5fE11e9c515B7108acd"
      chain                  = "celo"
      quicknode_network_name = "celo-mainnet"
    }
  }

  validation {
    condition = alltrue([
      for k, v in var.multisigs :
      can(regex("^0x[a-fA-F0-9]{40}$", v.address))
    ])
    error_message = "All multisig addresses must be valid Ethereum addresses (0x followed by 40 hexadecimal characters)."
  }

  validation {
    condition = alltrue([
      for k, v in var.multisigs :
      length(v.name) > 0
    ])
    error_message = "All multisigs must have a non-empty name."
  }

  validation {
    condition = alltrue([
      for k, v in var.multisigs :
      contains(["celo", "ethereum"], v.chain)
    ])
    error_message = "All multisigs must have a valid chain name: celo or ethereum."
  }

  validation {
    condition = alltrue([
      for k, v in var.multisigs :
      contains([
        "0g-mainnet", "abstract-mainnet", "abstract-testnet", "arc-testnet", "arbitrum-mainnet", "arbitrum-sepolia",
        "avalanche-fuji", "avalanche-mainnet", "b3-mainnet", "b3-sepolia", "base-mainnet", "base-sepolia",
        "bera-mainnet", "bera-bepolia", "bch-mainnet", "bch-testnet", "bitcoin-mainnet", "blast-mainnet",
        "blast-sepolia", "bnbchain-mainnet", "bnbchain-testnet", "celo-mainnet", "cyber-mainnet", "cyber-sepolia",
        "ethereum-hoodi", "ethereum-mainnet", "ethereum-sepolia", "fantom-mainnet", "flare-coston2", "flare-mainnet",
        "flow-mainnet", "flow-testnet", "fraxtal-mainnet", "gnosis-mainnet", "gravity-alpham", "hemi-mainnet",
        "hemi-testnet", "hyperevm-mainnet", "imx-mainnet", "imx-testnet", "injective-mainnet", "injective-testnet",
        "ink-mainnet", "ink-sepolia", "joc-mainnet", "kaia-mainnet", "kaia-testnet", "lens-mainnet", "lens-testnet",
        "linea-mainnet", "lisk-mainnet", "mantle-mainnet", "mantle-sepolia", "mode-mainnet", "monad-testnet",
        "morph-hoodie", "morph-mainnet", "nova-mainnet", "nomina-mainnet", "nomina-omega", "optimism-mainnet",
        "optimism-sepolia", "peaq-mainnet", "plasma-mainnet", "plasma-testnet", "polygon-amoy", "polygon-mainnet",
        "redstone-mainnet", "sahara-testnet", "scroll-mainnet", "scroll-testnet", "sei-mainnet", "sei-testnet",
        "solana-devnet", "solana-mainnet", "solana-testnet", "sonic-mainnet", "soneium-mainnet", "sophon-mainnet",
        "sophon-testnet", "story-aeneid", "story-mainnet", "tron-mainnet", "unichain-mainnet", "unichain-sepolia",
        "vana-mainnet", "vana-moksha", "worldchain-mainnet", "worldchain-sepolia", "xai-mainnet", "xai-sepolia",
        "xlayer-mainnet", "xrp-mainnet", "xrplevm-mainnet", "xrplevm-testnet", "xrp-testnet", "zerog-galileo",
        "zkevm-cardona", "zkevm-mainnet", "zksync-mainnet", "zksync-sepolia", "zora-mainnet"
      ], v.quicknode_network_name)
    ])
    error_message = "All multisigs must have a valid QuickNode network name. See QuickNode API documentation for supported networks."
  }
}

#####################
# Debug Configuration
#####################

variable "debug_mode" {
  description = "Enable per-resource debug logging on the QuickNode and Slack restapi providers. With TF_LOG=DEBUG the full HTTP request/response gets logged — that leaks the QuickNode `x-api-key` header + `security_token` body field and the Slack `Authorization: Bearer xoxb-...` header. Keep false in CI; only flip when actively debugging."
  type        = bool
  default     = false
}

#####################
# Google Cloud Variables
#####################

variable "project_name" {
  description = "Name for the GCP project. Project ID will be generated from this with a random suffix."
  type        = string
  default     = "alerts"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_name))
    error_message = "Project name must be 6-30 characters, start with a letter, and contain only lowercase letters, numbers, and hyphens."
  }
}

variable "org_id" {
  description = "GCP organization ID for the existing Mento organization. Keep this non-null so CI plans do not drift the project_factory module against live state."
  type        = string
  default     = "599540483579"
}

variable "billing_account" {
  description = "GCP billing account ID (required)"
  type        = string

  validation {
    condition     = can(regex("^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$", var.billing_account))
    error_message = "Billing account must be in format XXXXXX-XXXXXX-XXXXXX."
  }
}

variable "region" {
  description = "Google Cloud region for resources"
  type        = string
  default     = "europe-west1"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "Region must be a valid GCP region (e.g., us-central1, europe-west1)."
  }
}

#####################
# QuickNode Variables
#####################

variable "quicknode_api_key" {
  description = "QuickNode API key for webhook creation"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.quicknode_api_key) > 0
    error_message = "QuickNode API key must not be empty."
  }
}

variable "quicknode_signing_secret" {
  description = "Secret for verifying QuickNode webhook signatures (generate with: openssl rand -hex 32)"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.quicknode_signing_secret) >= 32
    error_message = "QuickNode signing secret must be at least 32 characters for security."
  }
}

#####################
# GitHub Configuration
#####################

# Fine-grained PAT for managing the `TF_VAR_*` repo secrets consumed by
# `.github/workflows/alerts-infra.yml`. Least-privilege scopes:
#   - Repository: mento-protocol/monitoring-monorepo (this one only)
#   - Permissions: Secrets (read & write)
# Generate at https://github.com/settings/personal-access-tokens/new with
# expiry — rotate before expiry and re-apply.
variable "github_token" {
  description = "Fine-grained GitHub PAT scoped to monitoring-monorepo with Secrets read/write. Used to manage the TF_VAR_* repo secrets consumed by the alerts-infra CI workflow."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.github_token) > 0
    error_message = "GitHub PAT must not be empty."
  }
}

#####################
# Labeling & Tagging
#####################

variable "additional_labels" {
  description = "Additional labels to apply to all resources. Common labels include: environment, cost-center, team, etc."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for key, value in var.additional_labels :
      length(key) <= 63 && length(value) <= 63
    ])
    error_message = "Label keys and values must be 63 characters or less (GCP requirement)."
  }
}
