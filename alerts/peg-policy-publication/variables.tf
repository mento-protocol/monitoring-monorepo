variable "terraform_service_account" {
  description = "Existing identity used by the selected publication workflow lane."
  type        = string
  default     = "peg-policy-publisher@mento-monitoring.iam.gserviceaccount.com"

  validation {
    condition     = var.terraform_service_account == "peg-policy-publication-reader@mento-terraform-seed-ffac.iam.gserviceaccount.com" || var.terraform_service_account == "peg-policy-publisher@mento-monitoring.iam.gserviceaccount.com"
    error_message = "terraform_service_account must be the Peg policy publication reader or publisher."
  }
}
