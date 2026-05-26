locals {
  # Map of project slug → project object. Auto-discovered from the Sentry
  # organization; the `sentry_alert` and `sentry_project_issue_stream_monitor`
  # resources fan out across this map via `for_each`.
  projects = {
    for project in data.sentry_all_projects.all.projects :
    project.slug => project
  }

  # Comma-separated tag list shown in Slack notifications. The `sentry_alert`
  # Slack action takes a single string, not a list (different from the
  # deprecated `sentry_issue_alert` resource).
  slack_tags = "url,browser,device,os,environment,level,handled"

  # Sentry's numeric level scale: debug=10, info=20, warning=30, error=40,
  # fatal=50. Used by the critical-fan-out filter to match only fatals.
  level_fatal = 50
}
