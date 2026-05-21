variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "region" {
  description = "Google Cloud region for the function"
  type        = string
  default     = "europe-west1"
}

variable "common_labels" {
  description = "Common labels to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "function_name" {
  description = "Name of the Cloud Function"
  type        = string
  default     = "onchain-event-handler"
}

variable "memory_mb" {
  description = "Memory allocation for the function in MB"
  type        = number
  default     = 256
}

variable "timeout_seconds" {
  description = "Function timeout in seconds"
  type        = number
  default     = 60
}

variable "max_instances" {
  description = "Maximum number of function instances"
  type        = number
  default     = 10
}

variable "min_instances" {
  description = "Minimum number of function instances (0 for cold start)"
  type        = number
  default     = 0
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

# Dynamic multisig webhook configuration
# This replaces hardcoded individual webhook variables with a flexible structure
# Supports multisigs from multiple chains in a single deployment
variable "multisig_webhooks" {
  description = "Map of multisig configurations with their Discord webhook URLs (can include multiple chains)"
  type = map(object({
    address        = string
    name           = string
    chain          = string
    alerts_webhook = string
    events_webhook = string
  }))
  sensitive = true

  validation {
    condition = alltrue([
      for k, v in var.multisig_webhooks :
      can(regex("^0x[a-fA-F0-9]{40}$", v.address))
    ])
    error_message = "All multisig addresses must be valid Ethereum addresses."
  }

  validation {
    condition = alltrue([
      for k, v in var.multisig_webhooks :
      can(regex("^https://discord.com/api/webhooks/", v.alerts_webhook)) &&
      can(regex("^https://discord.com/api/webhooks/", v.events_webhook))
    ])
    error_message = "All webhook URLs must be valid Discord webhook URLs."
  }
}

variable "project_service_account_email" {
  description = "Email of the project service account to use for Cloud Build (created by project factory when create_project_sa = true)"
  type        = string
  default     = null
}

variable "runtime" {
  description = "Cloud Function runtime (e.g., nodejs22, nodejs20)"
  type        = string
  default     = "nodejs22"
}

variable "secret_name" {
  description = "Name of the Secret Manager secret for QuickNode signing secret"
  type        = string
  default     = "quicknode-signing-secret"
}

