terraform {
  required_version = ">= 1.10.0"
  required_providers {
    sentry = {
      source = "jianyuan/sentry"
      # Match the root's exact stable pin. Version 0.15.4 trims a leading `#`
      # when comparing Sentry Slack action channel names (upstream PR #897),
      # so the existing bare per-project names remain state-equivalent to
      # Sentry's API response.
      version = "0.15.4"
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
