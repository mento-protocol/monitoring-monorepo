output "peg_policy_bucket" {
  description = "Private bucket containing the immutable Peg policy generation."
  value       = google_storage_bucket_object.peg_policy.bucket
}

output "peg_policy_object_name" {
  description = "Canonical policy object name within the private bucket."
  value       = google_storage_bucket_object.peg_policy.name
}

output "peg_policy_generation" {
  description = "Provider-observed positive GCS generation for the published policy."
  value       = tonumber(google_storage_bucket_object.peg_policy.generation)
}

output "peg_policy_url" {
  description = "Canonical generation-pinned GCS JSON media URL for later runtime activation."
  value       = "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=${tonumber(google_storage_bucket_object.peg_policy.generation)}"
}
