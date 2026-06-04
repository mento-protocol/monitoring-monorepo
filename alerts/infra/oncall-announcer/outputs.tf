output "function_location" {
  description = "Location of the deployed Cloud Function"
  value       = google_cloudfunctions2_function.oncall_announcer.location
}

output "function_name" {
  description = "Name of the Cloud Function"
  value       = google_cloudfunctions2_function.oncall_announcer.name
}

output "function_url" {
  description = "URL of the deployed Cloud Function"
  value       = google_cloudfunctions2_function.oncall_announcer.service_config[0].uri
}

output "rotation_state_bucket" {
  description = "GCS bucket storing the last announced on-call state"
  value       = google_storage_bucket.rotation_state.name
}

output "scheduler_job_name" {
  description = "Name of the Cloud Scheduler job"
  value       = google_cloud_scheduler_job.oncall_rotation.name
}
