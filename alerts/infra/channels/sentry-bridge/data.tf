################
# Sentry Data Sources
################

# Get organization details
data "sentry_organization" "main" {
  slug = var.sentry_organization_slug
}

# Get team details
data "sentry_team" "main" {
  organization = data.sentry_organization.main.internal_id
  slug         = var.sentry_team_slug
}

# Get Slack integration details — the Sentry-owned Slack OAuth app installed
# at the org level. This is NOT the same Slack token Grafana uses; Sentry's
# Slack integration is a separate OAuth app installed via Sentry → Settings →
# Integrations → Slack. The data source fails if the app isn't installed.
data "sentry_organization_integration" "slack" {
  organization = data.sentry_organization.main.internal_id
  provider_key = "slack"
  name         = var.sentry_slack_workspace_name
}

# Get all projects in the organization
data "sentry_all_projects" "all" {
  organization = data.sentry_organization.main.internal_id
}

# Resolve each project's default issue-stream monitor. `sentry_alert` is a
# supertype that fires on monitor lifecycle events (first_seen / regression
# / reappeared), so it needs a monitor ID per project. The issue-stream
# monitor covers all issue types (errors, performance, replay, etc.) — the
# broadest default monitor, closest to the previous "any error" semantics.
#
# `first = true` guards against a project ever having multiple issue-stream
# monitors (e.g. legacy click-ops or experimentation in the Sentry UI). The
# provider docs are explicit: without it, the data source errors when more
# than one monitor matches, which would fail the apply for ALL projects
# because the for_each rolls up to a single plan.
data "sentry_project_issue_stream_monitor" "default" {
  for_each = local.projects

  organization = data.sentry_organization.main.internal_id
  project      = each.key
  first        = true
}
