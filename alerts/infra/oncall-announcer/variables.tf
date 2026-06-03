variable "announce_on_first_run" {
  description = "Whether the first scheduler run after deployment should post the current on-call engineer to Slack. When false, the first run only seeds state and reconciles the Slack usergroup."
  type        = bool
  default     = true
}

variable "common_labels" {
  description = "Common labels to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "function_name" {
  description = "Name of the Cloud Function"
  type        = string
  default     = "oncall-announcer"
}

variable "max_instances" {
  description = "Maximum number of Cloud Function instances. Keep this low so overlapping scheduler retries do not race on rotation state."
  type        = number
  default     = 1
}

variable "memory_mb" {
  description = "Memory allocation for the function in MB"
  type        = number
  default     = 256
}

variable "min_instances" {
  description = "Minimum number of Cloud Function instances"
  type        = number
  default     = 0
}

variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "project_service_account_email" {
  description = "Email of the project service account to use for Cloud Build"
  type        = string
}

variable "cloudbuild_builder_dependency" {
  description = "Opaque dependency token for the shared Cloud Build builder IAM grant."
  type        = string
}

variable "region" {
  description = "Google Cloud region for the function and scheduler"
  type        = string
  default     = "europe-west1"
}

variable "runtime" {
  description = "Cloud Function runtime"
  type        = string
  default     = "nodejs22"
}

variable "schedule" {
  description = "Cloud Scheduler cron expression for polling Splunk On-Call. State dedupe prevents duplicate announcements when this runs more often than the rotation cadence."
  type        = string
  default     = "*/15 * * * *"
}

variable "scheduler_name" {
  description = "Name of the Cloud Scheduler job"
  type        = string
  default     = "oncall-rotation-check"
}

variable "slack_bot_token" {
  description = "Slack bot OAuth token used to post on-call rotation announcements and update the support-engineer usergroup."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.slack_bot_token, "xoxb-")
    error_message = "slack_bot_token must be a Slack bot OAuth token starting with 'xoxb-'."
  }
}

variable "slack_channel_id" {
  description = "Slack channel ID for #eng on-call rotation announcements."
  type        = string

  validation {
    condition     = can(regex("^[CG][A-Z0-9]{8,}$", var.slack_channel_id))
    error_message = "slack_channel_id must be a Slack channel ID such as C0123ABC456."
  }
}

variable "slack_support_usergroup_id" {
  description = "Slack usergroup ID for @support-engineer. The function replaces membership with exactly the current on-call engineer."
  type        = string

  validation {
    condition     = can(regex("^S[A-Z0-9]{8,}$", var.slack_support_usergroup_id))
    error_message = "slack_support_usergroup_id must be a Slack usergroup ID such as S0123ABC456."
  }
}

variable "splunk_on_call_api_base_url" {
  description = "Base URL for the Splunk On-Call public API. The historical VictorOps API host remains the canonical endpoint."
  type        = string
  default     = "https://api.victorops.com"
}

variable "splunk_on_call_api_id" {
  description = "Splunk On-Call API ID used for X-VO-Api-Id."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.splunk_on_call_api_id) > 0
    error_message = "splunk_on_call_api_id must not be empty."
  }
}

variable "splunk_on_call_api_key" {
  description = "Splunk On-Call API key used for X-VO-Api-Key. A read-only key is sufficient."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.splunk_on_call_api_key) > 0
    error_message = "splunk_on_call_api_key must not be empty."
  }
}

variable "splunk_on_call_escalation_policy_slug" {
  description = "Optional Splunk On-Call escalation policy slug to select when the team has multiple current schedules."
  type        = string
  default     = ""
}

variable "splunk_on_call_team_slug" {
  description = "Optional Splunk On-Call team slug to select. When empty, the function preserves the old announcer behavior and uses the first team returned by /oncall/current."
  type        = string
  default     = ""
}

variable "support_issues_url" {
  description = "Support issue board linked from the Slack rotation announcement."
  type        = string
  default     = "https://linear.app/mento-labs/team/SUP/all?layout=board&ordering=priority&grouping=workflowState&subGrouping=none&showCompletedIssues=all&showSubIssues=true&showTriageIssues=false"
}

variable "timeout_seconds" {
  description = "Cloud Function timeout in seconds"
  type        = number
  default     = 60
}

variable "time_zone" {
  description = "Cloud Scheduler time zone"
  type        = string
  default     = "Europe/Berlin"
}
