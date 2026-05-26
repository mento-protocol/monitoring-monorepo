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
  description = "Function timeout in seconds. Bumped from 60s to 300s to reduce QuickNode batch-retry duplicates: each webhook event can issue multiple 5s RPC calls + a 10s notification POST, and large batches used to run in parallel under Promise.all could blow the old 60s ceiling. A 300s ceiling gives substantial headroom."
  type        = number
  default     = 300
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

# Dynamic multisig notification configuration
# This replaces hardcoded individual destination variables with a flexible structure
# Supports multisigs from multiple chains in a single deployment
variable "multisig_notifications" {
  description = "Map of multisig configurations with their Slack destination channel IDs (can include multiple chains)"
  type = map(object({
    address           = string
    name              = string
    chain             = string
    alerts_channel_id = string
    events_channel_id = string
  }))
  sensitive = true

  validation {
    condition = alltrue([
      for k, v in var.multisig_notifications :
      can(regex("^0x[a-fA-F0-9]{40}$", v.address))
    ])
    error_message = "All multisig addresses must be valid Ethereum addresses."
  }

  validation {
    condition = alltrue([
      for k, v in var.multisig_notifications :
      can(regex("^C[A-Z0-9]+$", v.alerts_channel_id)) &&
      can(regex("^C[A-Z0-9]+$", v.events_channel_id))
    ])
    error_message = "All Slack channel IDs must start with C and contain only uppercase letters or numbers."
  }
}

variable "slack_bot_token" {
  description = "Slack bot OAuth token used by the Cloud Function to post on-chain event notifications with chat.postMessage."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.slack_bot_token, "xoxb-")
    error_message = "slack_bot_token must be a Slack bot OAuth token starting with 'xoxb-'."
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
