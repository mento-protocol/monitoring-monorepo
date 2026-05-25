################
# Sentry Data Sources
################

# Get organization details
data "sentry_organization" "main" {
  slug = var.sentry_organization_slug
}

# Get team details
data "sentry_team" "main" {
  organization = data.sentry_organization.main.id
  slug         = var.sentry_team_slug
}

# Get Discord integration details
data "sentry_organization_integration" "discord" {
  organization = data.sentry_organization.main.id
  provider_key = "discord"
  name         = var.discord_server_name
}

# Get all projects in the organization
data "sentry_all_projects" "all" {
  organization = data.sentry_organization.main.id
}

