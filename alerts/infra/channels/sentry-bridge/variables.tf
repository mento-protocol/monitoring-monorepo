######################
# Sentry Variables
######################

variable "sentry_organization_slug" {
  description = "Sentry organization slug (from URL: https://[slug].sentry.io)"
  type        = string
}

variable "sentry_team_slug" {
  description = "Sentry team slug"
  type        = string
}

######################
# Discord Variables
######################

variable "discord_server_id" {
  description = "Discord server ID"
  type        = string
}

variable "discord_server_name" {
  description = "Discord server name as it appears in Sentry"
  type        = string
}

variable "discord_category_id" {
  description = "Discord category ID where alert channels will be created"
  type        = string
}

variable "discord_sentry_role_id" {
  description = "Discord role ID for the Sentry integration (right-click the Sentry role on Discord and copy ID)"
  type        = string
}
