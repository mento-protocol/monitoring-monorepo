output "sentry_organization" {
  description = "The Sentry organization details"
  value       = data.sentry_organization.main
}

output "sentry_team" {
  description = "The Sentry team ID"
  value       = data.sentry_team.main.id
}

output "discord_channels" {
  description = "Discord channel IDs for each project's alerts"
  value = {
    for project, channel in discord_text_channel.sentry_alerts :
    trimprefix(project, "sentry-") => channel.id
  }
}

output "sentry_projects" {
  description = "List of monitored Sentry projects"
  value = [
    for project in data.sentry_all_projects.all.projects :
    project.slug
  ]
}
