terraform {
  required_version = ">= 1.11"

  # This state is deliberately separate from both Grafana rules and the
  # source-foundation stack. Publishing a new immutable policy generation has
  # its own cadence and protected approval boundary.
  backend "gcs" {
    bucket                      = "mento-terraform-tfstate-6ed6"
    prefix                      = "peg-policy-publication"
    impersonate_service_account = "org-terraform@mento-terraform-seed-ffac.iam.gserviceaccount.com"
  }

  required_providers {
    # Upgrade gate: this root intentionally stays on v6.50 because its
    # deprecated detect_md5hash behavior closes out-of-band object-byte drift.
    # Re-review the exact provider source and this reconciliation contract
    # before changing the Google provider version.
    google = {
      source  = "hashicorp/google"
      version = "~> 6.50.0"
    }
  }
}
