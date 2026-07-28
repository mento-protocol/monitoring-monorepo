locals {
  peg_policy_bucket          = "mento-monitoring-peg-policy"
  peg_policy_object          = "peg-policy/current.json"
  peg_policy_source          = file("${path.module}/../rules/peg-thresholds.json")
  peg_policy_source_md5_hex  = md5(local.peg_policy_source)
  peg_policy_base64_alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  peg_policy_source_md5_base64 = join("", concat(
    flatten([
      for offset in range(0, 30, 3) : [
        substr(local.peg_policy_base64_alphabet, floor(parseint(substr(local.peg_policy_source_md5_hex, offset, 3), 16) / 64), 1),
        substr(local.peg_policy_base64_alphabet, parseint(substr(local.peg_policy_source_md5_hex, offset, 3), 16) % 64, 1),
      ]
    ]),
    [
      substr(local.peg_policy_base64_alphabet, floor(parseint(substr(local.peg_policy_source_md5_hex, 30, 2), 16) / 4), 1),
      substr(local.peg_policy_base64_alphabet, (parseint(substr(local.peg_policy_source_md5_hex, 30, 2), 16) % 4) * 16, 1),
      "=",
    ],
  ))
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
  # Google provider v6.50 compares this known content hash with the current
  # object, so a manual plan exposes an out-of-band byte overwrite. It expects
  # the MD5 bytes encoded as Base64, not Terraform md5()'s hexadecimal text.
  # Terraform has no hexdecode(), so the source-derived local converts each
  # MD5 nibble group to the required Base64 value. `source_md5hash` is
  # replacement-oriented and would conflict with prevent_destroy. Do not
  # substitute it for this drift check.
  detect_md5hash  = local.peg_policy_source_md5_base64
  deletion_policy = "ABANDON"

  lifecycle {
    prevent_destroy = true

    postcondition {
      condition     = can(tonumber(self.generation)) && tonumber(self.generation) > 0
      error_message = "GCS must report a positive immutable generation for the published Peg policy."
    }
  }
}
