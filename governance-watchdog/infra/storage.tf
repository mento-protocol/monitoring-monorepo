# Create the Storage Bucket for the Cloud Function source code
resource "google_storage_bucket" "watchdog_notifications_function" {
  project                     = module.governance_watchdog.project_id
  name                        = "${module.governance_watchdog.project_id}-watchdog-cloud-function" # Every bucket name must be globally unique
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning {
    enabled = true
  }
  logging {
    log_bucket = google_storage_bucket.logging.id
  }

  force_destroy = true
}

# Compute a hash of the source files to detect actual changes
# This is more reliable than using the zip's SHA256 which includes metadata
locals {
  source_files = fileset("${path.module}/..", "src/**")
  package_files = [
    "${path.module}/../package.json",
    "${path.module}/../pnpm-lock.yaml",
    "${path.module}/../pnpm-workspace.yaml",
    # tsconfig files are build inputs: the Cloud Build `gcp-build` step runs
    # `tsc --project tsconfig.build.json` (which extends tsconfig.json), so a
    # change to either alters the emitted JS and must bust the source hash.
    "${path.module}/../tsconfig.json",
    "${path.module}/../tsconfig.build.json"
  ]
  # Create a hash of all source files and package files
  source_hash = md5(join("", [
    for f in sort(concat(tolist(local.source_files), local.package_files)) :
    fileexists("${path.module}/../${f}") ? filemd5("${path.module}/../${f}") : filemd5(f)
  ]))
}

# Zip the Cloud Function source code
data "archive_file" "function_source" {
  type        = "zip"
  source_dir  = "${path.module}/.."
  output_path = "${path.module}/../function-source.zip"

  # Not sure if this is strictly necessary when defining a .gcloudignore file, but better safe than sorry
  excludes = [
    ".env",
    ".env.example",
    ".env.yaml",
    ".git",
    ".gitignore",
    ".trunk",
    ".vscode",
    ".cursor",
    ".github",
    ".DS_Store",
    ".project_vars_cache",
    "bin",
    "arch-diagram.png",
    "DEPLOY_FROM_SCRATCH.md",
    "README.md",
    "dist",
    "commitlint.config.mjs",
    "eslint.config.mjs",
    "infra",
    "node_modules",
    "function-source.zip",
    ".terraform",
    ".terraform.lock.hcl"
  ]
}


# Upload the Cloud Function source code to the bucket
resource "google_storage_bucket_object" "source_code" {
  # Use our custom source hash instead of the archive's SHA256
  # This ensures the function only redeploys when actual source files change
  name   = "function-source-${local.source_hash}.zip"
  bucket = google_storage_bucket.watchdog_notifications_function.name
  source = data.archive_file.function_source.output_path
}

# Create the Storage Bucket for access logs
resource "google_storage_bucket" "logging" {
  #checkov:skip=CKV_GCP_62:The logging bucket can't log to itself (circular dependency)
  project                     = module.governance_watchdog.project_id
  name                        = "${module.governance_watchdog.project_id}-logging" # Every bucket name must be globally unique
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  force_destroy = true
}
