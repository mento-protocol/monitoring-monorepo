# For consistency we also keep this variable in here, although it's not used in the Terraform code (only in the shell scripts)
variable "terraform_service_account" {
  type        = string
  description = "Service account of our Terraform GCP Project which can be impersonated to create and destroy resources in this project"
  default     = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
}

# For consistency we also keep this variable in here, although it's not used in the Terraform code (only in the shell scripts)
# trunk-ignore(tflint/terraform_unused_declarations)
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

variable "sentry_team_slug" {
  description = "Sentry team slug"
  type        = string
  default     = "mento-labs"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.sentry_team_slug))
    error_message = "Sentry team slug must contain only lowercase letters, numbers, and hyphens."
  }
}

#####################
# Discord Variables
#####################

variable "discord_bot_token" {
  description = "Discord bot token"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.discord_bot_token) > 50
    error_message = "Discord bot token must be a valid token string."
  }
}

variable "discord_server_id" {
  description = "Discord server ID (snowflake ID)"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{17,20}$", var.discord_server_id))
    error_message = "Discord server ID must be a valid snowflake ID (17-20 digit number)."
  }
}

variable "discord_server_name" {
  description = "Discord server name as it appears in Sentry integrations"
  type        = string
  default     = "Mento"
}

variable "discord_category_id" {
  description = "Discord category ID where alert channels will be created"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{17,20}$", var.discord_category_id))
    error_message = "Discord category ID must be a valid snowflake ID (17-20 digit number)."
  }
}

variable "discord_sentry_role_id" {
  description = "Discord role ID for the Sentry integration (right-click the Sentry role on Discord and copy ID)"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{17,20}$", var.discord_sentry_role_id))
    error_message = "Discord role ID must be a valid snowflake ID (17-20 digit number)."
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
  description = "Enable debug mode for REST API provider"
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
  description = "GCP organization ID"
  type        = string
  default     = null
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
