locals {
  # Get all projects from Sentry organization
  # This includes both existing projects and any projects we create in this module
  # The data source will automatically discover our managed projects after they're created
  projects = {
    for project in data.sentry_all_projects.all.projects :
    project.slug => project
  }

  # Discord permission constants
  discord_view_channel_permission = 1024 # View Channel permission (1 << 10)

  # Sort project slugs alphabetically to ensure channels are created in alphabetical order
  sorted_project_slugs = sort(keys(local.projects))

  # Calculate channel positions alphabetically, starting at 100
  # This ensures new channels appear after existing channels and are sorted alphabetically
  channel_positions = {
    for idx, project_slug in local.sorted_project_slugs :
    project_slug => 100 + idx
  }
}

