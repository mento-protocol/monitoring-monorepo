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

output "metrics_bridge_url" {
  description = "Cloud Run URL for the metrics bridge — add as Grafana Agent scrape target."
  value       = length(google_cloud_run_v2_service.metrics_bridge) > 0 ? google_cloud_run_v2_service.metrics_bridge[0].uri : ""
}
