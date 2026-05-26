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

    # restapi.slack is configured at the root in `alerts/infra/providers.tf`
    # and passed in via the module's `providers = { restapi.slack = ... }`
    # mapping. Used to create and archive the per-project `#sentry-<slug>`
    # Slack channels via Slack's `conversations.create` and
    # `conversations.archive` endpoints.
    restapi = {
      source                = "mastercard/restapi"
      version               = ">= 2.0.1"
      configuration_aliases = [restapi.slack]
    }
  }
}

# Providers are passed from the root module.
