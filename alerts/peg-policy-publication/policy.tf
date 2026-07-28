locals {
  peg_policy_bucket = "mento-monitoring-peg-policy"
  peg_policy_object = "peg-policy/current.json"
  peg_policy_source = file("${path.module}/../rules/peg-thresholds.json")
}

# The same object name is intentional: versioning in the private foundation
# bucket retains each upload as an immutable generation. Runtime activation is
# a later change and consumes only the generation-pinned URL output below.
resource "google_storage_bucket_object" "peg_policy" {
  bucket        = local.peg_policy_bucket
  name          = local.peg_policy_object
  content       = local.peg_policy_source
  content_type  = "application/json"
  cache_control = "no-store"
  # Pinned Google provider v6.50 compares this known content hash with the
  # current object, so a manual plan exposes an out-of-band overwrite. Its
  # replacement-oriented `source_md5hash` alternative conflicts with this
  # resource's no-destroy lifecycle and must not be substituted casually.
  detect_md5hash  = md5(local.peg_policy_source)
  deletion_policy = "ABANDON"

  lifecycle {
    prevent_destroy = true

    postcondition {
      condition     = can(tonumber(self.generation)) && tonumber(self.generation) > 0
      error_message = "GCS must report a positive immutable generation for the published Peg policy."
    }
  }
}
