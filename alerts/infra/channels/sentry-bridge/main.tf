################
# Discord Setup #
################

# Grant the Sentry integration access to the Discord category
resource "discord_channel_permission" "sentry_category_access" {
  channel_id   = var.discord_category_id
  overwrite_id = var.discord_sentry_role_id
  type         = "role"
  allow        = local.discord_view_channel_permission
  deny         = 0 # Don't explicitly deny any permissions
}

# Create Discord alert channels for each Sentry project
resource "discord_text_channel" "sentry_alerts" {
  for_each = local.projects

  name                     = "sentry-${each.key}"
  server_id                = var.discord_server_id
  category                 = var.discord_category_id
  topic                    = "Sentry alerts for ${each.key} project"
  sync_perms_with_category = true
  position                 = local.channel_positions[each.key]
}

###############
# Alert Rules #
###############

# Create alert rules that forward Sentry errors to Discord
resource "sentry_issue_alert" "discord_alerts" {
  for_each = local.projects

  organization = data.sentry_organization.main.id
  project      = each.key
  name         = "${each.key} - Forward to Discord"

  action_match = "any" # Trigger if any condition is met
  filter_match = "any" # Trigger if any filter matches
  frequency    = 5     # Wait at least 5 minutes before re-triggering

  # Optional: Filter for specific error types. If alerts get too noisy, we can add more filters here.
  #   filters_v2 = [{
  #     issue_category = {
  #       value = "Error"
  #     }
  #   }]

  # Forward to Discord with the right context as defined in tags
  actions_v2 = [{
    discord_notify_service = {
      server     = data.sentry_organization_integration.discord.id
      channel_id = discord_text_channel.sentry_alerts[each.key].id
      tags       = ["url", "browser", "device", "os", "environment", "level", "handled"]
    }
  }]
}

###########################
# Sentry Project References #
###########################
# These projects are managed outside of Terraform.
# Terraform will reference them for alert rules and Discord channel setup.
# Projects must exist in Sentry before running terraform apply.
