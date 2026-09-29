output "function_url" {
  description = "URL of the deployed Cloud Function"
  value       = google_cloudfunctions2_function.onchain_event_handler.service_config[0].uri
}

output "function_name" {
  description = "Name of the Cloud Function"
  value       = google_cloudfunctions2_function.onchain_event_handler.name
}

output "function_location" {
  description = "Location of the Cloud Function"
  value       = google_cloudfunctions2_function.onchain_event_handler.location
}

output "pool_liquidity_retry_scheduler_job_name" {
  description = "Name of the Watched LP withdrawal retry Cloud Scheduler job"
  value       = google_cloud_scheduler_job.pool_liquidity_retry.name
}
