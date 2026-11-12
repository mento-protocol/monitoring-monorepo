# Synthetic Monitoring is gated on the access token. Both runs set the token
# explicitly, so the CI secret in TF_VAR_synthetic_monitoring_access_token
# never decides which path this file tests.
mock_provider "grafana" {
  # The real data source maps probe names to IDs. The default mock returns an
  # empty map, which would fail the probe lookup in synthetic-monitoring.tf.
  mock_data "grafana_synthetic_monitoring_probes" {
    defaults = {
      probes = {
        Frankfurt     = 101
        NorthVirginia = 202
        Singapore     = 303
      }
    }
  }
}

variables {
  grafana_service_account_token     = "fixture"
  slack_bot_token                   = "fixture"
  oncall_support_usergroup_id       = "S012345678"
  splunk_on_call_alerts_webhook_url = "https://example.invalid/splunk-on-call"
}

run "synthetic_checks_disabled_without_token" {
  command = plan

  variables {
    synthetic_monitoring_access_token = ""
  }

  assert {
    condition     = length(data.grafana_synthetic_monitoring_probes.public) == 0 && length(grafana_synthetic_monitoring_check.http) == 0
    error_message = "An empty Synthetic Monitoring token must manage no probes data source and no checks."
  }
}

run "synthetic_checks_enabled_with_token" {
  command = plan

  variables {
    synthetic_monitoring_access_token = "fixture"
  }

  assert {
    condition     = toset(keys(grafana_synthetic_monitoring_check.http)) == toset(["app-mento-org", "reserve-mento-org", "governance-mento-org", "ui-dashboard", "mento-analytics-api"])
    error_message = "A Synthetic Monitoring token must plan exactly the five production HTTP checks, keyed by stable job name."
  }

  assert {
    condition     = alltrue([for check in values(grafana_synthetic_monitoring_check.http) : toset(check.probes) == toset([101, 202])])
    error_message = "Each check must run from exactly the Frankfurt and NorthVirginia probes, resolved by name."
  }

  assert {
    condition = alltrue([
      for check in values(grafana_synthetic_monitoring_check.http) :
      check.enabled && check.frequency == 300000 && check.timeout == 10000 && check.alert_sensitivity == "none" &&
      check.labels.environment == "production" && startswith(check.target, "https://") &&
      toset(one(one(check.settings).http).valid_status_codes) == toset([200]) && one(one(check.settings).http).fail_if_not_ssl
    ])
    error_message = "Checks must stay record-only, run every 5 minutes with a 10 s timeout, and pass only on HTTP 200 over TLS."
  }

  assert {
    condition     = grafana_synthetic_monitoring_check.http["ui-dashboard"].target == "https://monitoring.mento.org" && grafana_synthetic_monitoring_check.http["ui-dashboard"].labels.service == "ui-dashboard"
    error_message = "The dashboard-availability SLO reads the ui-dashboard job; keep its target and service label."
  }
}
