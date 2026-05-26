######################
# Sentry Variables
######################

variable "sentry_organization_slug" {
  description = "Sentry organization slug (from URL: https://[slug].sentry.io)"
  type        = string
}

variable "sentry_slack_workspace_name" {
  description = "Slack workspace name as it appears in Sentry's Slack integration (Settings → Integrations → Slack). Case-sensitive."
  type        = string
}

######################
# Slack Channel Variables
######################

variable "slack_critical_channel" {
  description = "Slack channel name (with leading #) that receives the fatal-first-seen/regression critical fan-out from every project."
  type        = string
  default     = "#alerts-critical"

  # Sentry's Slack action accepts bare channel names silently (no plan/apply
  # error) but the notification will never land without the leading '#'.
  # Catch that footgun at plan time instead of at notify time.
  validation {
    condition     = can(regex("^#", var.slack_critical_channel))
    error_message = "slack_critical_channel must start with '#' (e.g. '#alerts-critical')."
  }
}
