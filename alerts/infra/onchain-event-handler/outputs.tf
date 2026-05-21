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

