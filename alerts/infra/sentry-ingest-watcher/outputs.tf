output "function_location" {
  description = "Location of the deployed Cloud Function"
  value       = google_cloudfunctions2_function.sentry_ingest_watcher.location
}

output "function_name" {
  description = "Name of the Cloud Function"
  value       = google_cloudfunctions2_function.sentry_ingest_watcher.name
}

output "function_url" {
  description = "URL of the deployed Cloud Function"
  value       = google_cloudfunctions2_function.sentry_ingest_watcher.service_config[0].uri
}

output "scheduler_job_name" {
  description = "Name of the Cloud Scheduler job"
  value       = google_cloud_scheduler_job.sentry_ingest_freshness.name
}
