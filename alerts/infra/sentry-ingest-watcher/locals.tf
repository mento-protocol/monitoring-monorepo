locals {
  source_files = [
    "${path.module}/freshness.mjs",
    "${path.module}/index.mjs",
    "${path.module}/package.json",
  ]

  # Runtime configuration is not part of the archive, so fold it into the
  # object name. Without this a schedule or workflow-file change would leave
  # the deployed revision running the old configuration.
  runtime_config_hash = md5(jsonencode({
    github_repository    = var.github_repository
    ingest_workflow_file = var.ingest_workflow_file
    metric_type          = var.metric_type
    schedule             = var.schedule
  }))

  source_hash = md5(join("", concat(
    [for f in sort(local.source_files) : fileexists(f) ? filemd5(f) : ""],
    [local.runtime_config_hash],
  )))

  environment_variables = {
    FRESHNESS_METRIC_TYPE = var.metric_type
    GCP_PROJECT_ID        = var.project_id
    GITHUB_REPOSITORY     = var.github_repository
    INGEST_WORKFLOW_FILE  = var.ingest_workflow_file
  }
}
