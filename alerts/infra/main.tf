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

# Forward Sentry errors to Slack (per-project channel + critical fan-out).
# `discord` provider is still passed because state contains Discord-typed
# resources scheduled for destroy on the next apply — Terraform requires
# the provider config to be available until those resources are gone. The
# mapping can be dropped in a follow-up PR once the migration apply
# completes and state no longer references Discord-typed resources.
module "sentry_bridge" {
  source = "./channels/sentry-bridge"

  providers = {
    sentry        = sentry
    discord       = discord
    restapi.slack = restapi.slack
  }

  # Sentry configuration
  sentry_organization_slug    = var.sentry_organization_slug
  sentry_slack_workspace_name = var.sentry_slack_workspace_name
  slack_critical_channel      = var.sentry_slack_critical_channel
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

#####################################################################
# GitHub Actions secrets — TF_VAR_* values for the alerts-infra
# workflow's plan/apply jobs (.github/workflows/alerts-infra.yml).
#
# The workflow reads these as ${{ secrets.TF_VAR_* }} into the job's
# `env:` block, terraform consumes them as input variables. Without
# this, the workflow's `terraform plan/apply` fails on variable
# validation (each required input has a `length(var.X) > 0` check).
#
# Sensitive values flow tfvars → terraform state → GitHub secrets
# store. The state path adds a fourth surface compared to a script
# (which writes only tfvars → GitHub directly) — accepted tradeoff
# in exchange for drift detection: someone editing a secret in the
# GitHub UI would surface as a TF diff. Secrets in state are
# encrypted at rest in GCS and gated by `org-terraform` impersonation
# (same gate as every other secret already managed here, e.g. the
# Sentry / Discord / QuickNode tokens above).
#
# Map: tfvars variable → secret name. Mirrors the env: block in
# alerts-infra.yml.
#####################################################################

locals {
  # The names set (non-sensitive) is what `for_each` iterates over —
  # Terraform rejects sensitive values as `for_each` keys because the keys
  # appear in plan output and resource addresses. Values are looked up
  # from a separate map keyed by the same names. Splitting these keeps the
  # iteration surface non-sensitive while the actual secret values flow
  # only through the resource's `value` field.
  alerts_infra_ci_secret_names = toset([
    "TF_VAR_SENTRY_AUTH_TOKEN",
    "TF_VAR_DISCORD_BOT_TOKEN",
    "TF_VAR_DISCORD_SERVER_ID",
    "TF_VAR_DISCORD_CATEGORY_ID",
    "TF_VAR_BILLING_ACCOUNT",
    "TF_VAR_QUICKNODE_API_KEY",
    "TF_VAR_QUICKNODE_SIGNING_SECRET",
    # Slack bot OAuth token (xoxb-...) consumed by the restapi.slack provider
    # in `providers.tf` to create + archive the per-Sentry-project Slack
    # channels. Same chicken-and-egg pattern as TF_VAR_GITHUB_TOKEN below —
    # the first time this secret is needed by CI, it has to be bootstrapped
    # manually via `gh secret set TF_VAR_SLACK_BOT_TOKEN` (done before this
    # commit landed). Subsequent rotations: update tfvars, re-apply, the
    # github_actions_secret resource keeps GH Actions in sync.
    "TF_VAR_SLACK_BOT_TOKEN",
    # Self-managed: the github provider's own PAT also lives in repo
    # secrets so CI can `terraform plan/apply` this stack (which manages
    # the github_actions_secret resources below). First apply is always
    # local — from a checkout with `github_token` in tfvars — to bootstrap
    # this secret. Subsequent CI runs find it in place and can re-apply
    # idempotently. Rotating the PAT: update tfvars, re-apply locally OR
    # via CI (CI works since the old PAT still authenticates until the
    # new one fully propagates).
    "TF_VAR_GITHUB_TOKEN",
  ])

  alerts_infra_ci_secret_values = {
    TF_VAR_SENTRY_AUTH_TOKEN        = var.sentry_auth_token
    TF_VAR_DISCORD_BOT_TOKEN        = var.discord_bot_token
    TF_VAR_DISCORD_SERVER_ID        = var.discord_server_id
    TF_VAR_DISCORD_CATEGORY_ID      = var.discord_category_id
    TF_VAR_BILLING_ACCOUNT          = var.billing_account
    TF_VAR_QUICKNODE_API_KEY        = var.quicknode_api_key
    TF_VAR_QUICKNODE_SIGNING_SECRET = var.quicknode_signing_secret
    TF_VAR_SLACK_BOT_TOKEN          = var.slack_bot_token
    TF_VAR_GITHUB_TOKEN             = var.github_token
  }
}

# trunk-ignore-begin(checkov/CKV_GIT_4): CKV_GIT_4 prefers `encrypted_value`
# (pre-libsodium-encrypted against the repo's public key) over the plaintext
# `value` field. The encrypted path requires an external libsodium step
# outside Terraform — non-trivial complexity for marginal benefit here: the
# state file is already encrypted at rest in GCS, gated by `org-terraform`
# impersonation (same gate that already protects sentry_auth_token /
# discord_bot_token / quicknode_signing_secret in this same state). The
# provider handles libsodium server-side against GitHub's public key on its
# way to the API. If the threat model ever shifts (state exposed to a wider
# audience), revisit — `gh secret set` and `data.github_actions_public_key`
# can build an `encrypted_value` pipeline.
resource "github_actions_secret" "alerts_infra_tf_vars" {
  for_each    = local.alerts_infra_ci_secret_names
  repository  = "monitoring-monorepo"
  secret_name = each.key
  value       = local.alerts_infra_ci_secret_values[each.key]
}
# trunk-ignore-end(checkov/CKV_GIT_4)
