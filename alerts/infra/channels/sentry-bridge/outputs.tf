output "sentry_organization" {
  description = "The Sentry organization details"
  value       = data.sentry_organization.main
}

output "slack_channels" {
  description = "Map of Sentry project slug → Slack channel name for the per-project default alert (unprefixed; matches the form Sentry persists — see main.tf:45 for the `#` strip rationale)"
  value = {
    for project_slug in keys(local.projects) :
    project_slug => "sentry-${project_slug}"
  }
}

output "sentry_projects" {
  description = "List of monitored Sentry projects"
  value = [
    for project in data.sentry_all_projects.all.projects :
    project.slug
  ]
}
