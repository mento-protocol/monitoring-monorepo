locals {
  source_files = [
    "${path.module}/freshness.mjs",
    "${path.module}/index.mjs",
    "${path.module}/package.json",
  ]

  # Runtime configuration is not part of the archive, so fold it into the
  # object name. Without this a schedule or tracker-issue change would leave
  # the deployed revision running the old configuration.
  runtime_config_hash = md5(jsonencode({
    github_repository = var.github_repository
    metric_type       = var.metric_type
    schedule          = var.schedule
    tracker_issue     = var.tracker_issue
  }))

  source_hash = md5(join("", concat(
    [for f in sort(local.source_files) : fileexists(f) ? filemd5(f) : ""],
    [local.runtime_config_hash],
  )))

  environment_variables = {
    FRESHNESS_METRIC_TYPE = var.metric_type
    GCP_PROJECT_ID        = var.project_id
    GITHUB_REPOSITORY     = var.github_repository
    TRACKER_ISSUE         = tostring(var.tracker_issue)
  }
}
