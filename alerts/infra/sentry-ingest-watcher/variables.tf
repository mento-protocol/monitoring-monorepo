variable "cloudbuild_builder_dependency" {
  description = "Opaque dependency token for the shared Cloud Build builder IAM grant."
  type        = string
}

variable "common_labels" {
  description = "Common labels to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "function_name" {
  description = "Name of the Cloud Function"
  type        = string
  default     = "sentry-ingest-watcher"
}

variable "github_repository" {
  description = "owner/name of the public repository holding the tracker issue. Read unauthenticated — the function holds no GitHub credential."
  type        = string
  default     = "mento-protocol/monitoring-monorepo"
}

variable "max_instances" {
  description = "Maximum number of Cloud Function instances. One scheduled caller needs no concurrency."
  type        = number
  default     = 1
}

variable "memory_mb" {
  description = "Memory allocation for the function in MB"
  type        = number
  default     = 256
}

variable "metric_type" {
  description = "Cloud Monitoring custom metric type carrying seconds since the ingest last recorded work on the tracker issue."
  type        = string
}

variable "min_instances" {
  description = "Minimum number of Cloud Function instances"
  type        = number
  default     = 0
}

variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "project_service_account_email" {
  description = "Email of the project service account to use for Cloud Build"
  type        = string
}

variable "region" {
  description = "Google Cloud region for the function and scheduler"
  type        = string
  default     = "europe-west1"
}

variable "runtime" {
  description = "Cloud Function runtime"
  type        = string
  default     = "nodejs24"
}

variable "schedule" {
  description = "Cloud Scheduler cron expression. Must stay at least twice as frequent as the alert's 7200s alignment period, so a single missed run still leaves a point in the bucket and cannot read as an absent series on a healthy pipeline."
  type        = string
  default     = "0 * * * *"
}

variable "scheduler_name" {
  description = "Name of the Cloud Scheduler job"
  type        = string
  default     = "sentry-ingest-freshness-check"
}

variable "tracker_issue" {
  description = "Sentry triage tracker issue carrying the rolling ingest run record. That record is written only after an ingest actually fetched and counted issues, so it is evidence of work; the workflow conclusion is not, because a kill-switched or token-less run still concludes success."
  type        = number
  default     = 1282

  validation {
    condition     = var.tracker_issue > 0 && floor(var.tracker_issue) == var.tracker_issue
    error_message = "tracker_issue must be a positive issue number."
  }
}

variable "timeout_seconds" {
  description = "Cloud Function timeout in seconds"
  type        = number
  default     = 60
}

variable "time_zone" {
  description = "Cloud Scheduler time zone"
  type        = string
  default     = "UTC"
}
