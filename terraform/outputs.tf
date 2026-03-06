output "vercel_project_id" {
  description = "Vercel project ID — used in GitHub Actions secrets."
  value       = vercel_project.dashboard.id
}

output "vercel_project_url" {
  description = "Production URL of the deployed dashboard."
  value       = "https://${vercel_project.dashboard.name}.vercel.app"
  # → https://monitoring-dashboard.vercel.app
}

output "upstash_redis_rest_url" {
  description = "Upstash Redis REST URL — also set as UPSTASH_REDIS_REST_URL env var."
  value       = local.redis_rest_url
}

output "upstash_redis_database_id" {
  description = "Upstash database ID — useful for console.upstash.com references."
  value       = upstash_redis_database.address_labels.database_id
}
