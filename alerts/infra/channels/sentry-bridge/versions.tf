terraform {
  required_version = ">= 1.10.0"
  required_providers {
    sentry = {
      source = "jianyuan/sentry"
      # See root versions.tf for full context.
      # 0.15.0-beta3 supports the `sentry_alert` supertype resource and the
      # `sentry_project_issue_stream_monitor` data source. The deprecated
      # `sentry_issue_alert` resource is no longer referenced by config, but
      # may still exist in state until apply destroys it.
      version = "0.15.0-beta3"
    }

    # Discord provider config is retained for the duration of the
    # Discord → Slack migration apply. Existing state still contains
    # `discord_text_channel.sentry_alerts[*]` and
    # `discord_channel_permission.sentry_category_access` resources;
    # Terraform requires the provider config to be available until those
    # resources are destroyed. Once the migration apply completes and
    # state no longer references Discord-typed resources, this block
    # (and the `providers = { discord = discord }` mapping in
    # `alerts/infra/main.tf`) can be removed in a follow-up PR.
    discord = {
      source  = "Lucky3028/discord"
      version = ">= 2.0.1"
    }
  }
}

# Providers are passed from the root module.
