#####################
# GCP Project Setup #
#####################

# Create GCP project using project-factory module
# See: https://github.com/terraform-google-modules/terraform-google-project-factory
module "project_factory" {
  source = "git::https://github.com/terraform-google-modules/terraform-google-project-factory.git?ref=1fcb3df2067667466e1bc6d7a3d2d085fdd06519" # commit hash of v18.2.0

  name              = var.project_name
  random_project_id = true # Always generate random suffix
  org_id            = var.org_id
  billing_account   = var.billing_account

  # Allow project deletion (needed for tear-down)
  deletion_policy = "DELETE"

  # Use project-specific service account
  default_service_account = "disable"
  create_project_sa       = true

  # Enable required APIs for Cloud Functions
  activate_apis = [
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "storage.googleapis.com",
    "logging.googleapis.com",
    "run.googleapis.com",              # Required for Cloud Functions Gen2
    "artifactregistry.googleapis.com", # Required for Cloud Functions Gen2
    "secretmanager.googleapis.com",    # Required for Secret Manager
  ]

  # Project labels (includes chain information)
  labels = local.common_labels
}

#####################
# Service Account   #
#####################

# Create project service account for Cloud Build
# This is needed when default_service_account is disabled
# Note: account_id cannot contain hyphens, so we use a simple name
resource "google_service_account" "project_sa" {
  project      = local.project_id
  account_id   = "cloudbuild-sa"
  display_name = "Project Service Account for Cloud Build"
  description  = "Service account used by Cloud Build to deploy Cloud Functions"

  depends_on = [module.project_factory]
}

###########
# Modules #
###########

# Preserve existing state on the rename from the vendored upstream names
# (`discord_channel_manager` / `sentry_alerts`) to the new names. Without
# these `moved` blocks, `terraform plan` against a previously-applied state
# would propose destroy+recreate of the Discord channels and Sentry alert
# rules — a recreate would invalidate webhook URLs and lose Sentry alert
# IDs. The `moved` blocks make the rename a no-op state migration.
moved {
  from = module.discord_channel_manager
  to   = module.discord_channels
}
moved {
  from = module.sentry_alerts
  to   = module.sentry_bridge
}

# Create Discord channels and webhooks for alerts and events
module "discord_channels" {
  source = "./channels/discord-channels"

  providers = {
    restapi.discord = restapi.discord
  }

  discord_server_id   = var.discord_server_id
  discord_category_id = var.discord_category_id
}

# Forward Sentry errors to Slack (per-project channel + critical fan-out)
module "sentry_bridge" {
  source = "./channels/sentry-bridge"

  providers = {
    sentry = sentry
  }

  # Sentry configuration
  sentry_organization_slug    = var.sentry_organization_slug
  sentry_team_slug            = var.sentry_team_slug
  sentry_slack_workspace_name = var.sentry_slack_workspace_name
}

# Deploy GCP Cloud Function for QuickNode webhook handling
module "onchain_event_handler" {
  source = "./onchain-event-handler"

  project_id    = local.project_id
  region        = var.region
  common_labels = local.common_labels

  # Project service account email (created explicitly above)
  project_service_account_email = google_service_account.project_sa.email

  quicknode_signing_secret = var.quicknode_signing_secret

  # Dynamic webhook configuration based on ALL multisigs (across all chains)
  # All multisigs share the same two webhook URLs
  multisig_webhooks = {
    for key, multisig in var.multisigs : key => {
      address        = multisig.address
      name           = multisig.name
      chain          = multisig.chain
      alerts_webhook = module.discord_channels.webhook_urls.alerts
      events_webhook = module.discord_channels.webhook_urls.events
    }
  }

  depends_on = [
    module.discord_channels,
    module.project_factory,
    google_service_account.project_sa
  ]
}

# Create QuickNode webhooks for on-chain event monitoring
# One webhook per chain (e.g., one for Celo, one for Ethereum, etc.)
module "onchain_event_listeners" {
  source = "./onchain-event-listeners"

  for_each = local.multisigs_by_chain

  providers = {
    restapi.quicknode = restapi.quicknode
  }

  webhook_endpoint_url = module.onchain_event_handler.function_url
  multisig_addresses   = [for k, v in each.value : v.address]
  webhook_name         = "safe-multisig-monitor-${each.key}"
  chain_key            = each.key
  # All multisigs in the same chain group must declare the same
  # quicknode_network_name. local.multisigs_by_chain_network is built from a
  # distinct() check in locals.tf — terraform plan fails with a clear error
  # if an operator mixes networks within one chain.
  quicknode_network_name   = local.multisigs_by_chain_network[each.key]
  quicknode_api_key        = var.quicknode_api_key
  quicknode_signing_secret = var.quicknode_signing_secret
  debug_mode               = var.debug_mode

  depends_on = [module.onchain_event_handler]
}
