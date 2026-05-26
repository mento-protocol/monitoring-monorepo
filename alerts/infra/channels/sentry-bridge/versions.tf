terraform {
  required_version = ">= 1.10.0"
  required_providers {
    sentry = {
      source = "jianyuan/sentry"
      # See root versions.tf for full context.
      # 0.15.0-beta3 supports the `sentry_alert` supertype resource and the
      # `sentry_project_issue_stream_monitor` data source. The deprecated
      # `sentry_issue_alert` resource is no longer used by this module.
      version = "0.15.0-beta3"
    }
  }
}

# Providers are passed from the root module.
# This module no longer manages Discord resources — `discord` provider was
# removed when the Sentry → Discord bridge was retired in favor of Slack.
