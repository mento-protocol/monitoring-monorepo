variable "channels" {
  description = "Slack channels for on-chain event delivery, keyed by logical route."
  type = map(object({
    name       = string
    is_private = optional(bool, false)
  }))
  default = {
    alerts = {
      name = "multisig-alerts"
    }
    events = {
      name = "multisig-events"
    }
  }

  validation {
    condition = alltrue([
      for _, channel in var.channels :
      can(regex("^[a-z0-9][a-z0-9_-]{0,78}$", channel.name))
    ])
    error_message = "Slack channel names must be lowercase and contain only letters, numbers, underscores, or hyphens."
  }
}
