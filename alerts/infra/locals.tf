# Local variables for consistent labeling across all resources
locals {
  # Common labels applied to all resources
  # Following AWS best practices for default tags (adapted for GCP labels)
  # See: https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/structure.html
  common_labels = merge(
    {
      managed_by = "terraform"
      purpose    = "alerts-monitoring"
      project    = "mento-alerts"
    },
    var.additional_labels
  )

  # Project ID from factory module
  project_id = module.project_factory.project_id

  # Group multisigs by chain for webhook creation
  multisigs_by_chain = {
    for chain in distinct([for k, v in var.multisigs : v.chain]) :
    chain => {
      for k, v in var.multisigs : k => v
      if v.chain == chain
    }
  }
}

