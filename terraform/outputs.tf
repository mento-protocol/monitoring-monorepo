output "vercel_project_id" {
  description = "Vercel project ID — used in GitHub Actions secrets."
  value       = vercel_project.dashboard.id
}

output "vercel_project_url" {
  description = "Production URL of the deployed dashboard."
  value       = "https://${vercel_project_domain.monitoring.domain}"
}

output "upstash_redis_rest_url" {
  description = "Upstash Redis REST URL — also set as UPSTASH_REDIS_REST_URL env var."
  value       = local.redis_rest_url
}

output "upstash_redis_database_id" {
  description = "Upstash database ID — useful for console.upstash.com references."
  value       = upstash_redis_database.address_labels.database_id
}

output "google_oauth_redirect_uri" {
  description = "Redirect URI to add to the Google OAuth client."
  value       = "https://${vercel_project_domain.monitoring.domain}/api/auth/callback/google"
}

output "gcp_project_id" {
  description = "GCP project ID for the monitoring project."
  value       = google_project.monitoring.project_id
}

output "artifact_registry_url" {
  description = "Artifact Registry Docker URL for pushing images."
  value       = "${var.gcp_region}-docker.pkg.dev/${google_project.monitoring.project_id}/${google_artifact_registry_repository.metrics_bridge.repository_id}"
}

output "metrics_bridge_url" {
  description = "Cloud Run URL for the metrics bridge — add as Grafana Agent scrape target."
  value       = google_cloud_run_v2_service.metrics_bridge.uri
}

output "metrics_bridge_image" {
  description = "Full container image reference used by the Cloud Run service."
  value       = local.metrics_bridge_image
}
