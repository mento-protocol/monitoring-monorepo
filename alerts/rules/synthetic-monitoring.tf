# Grafana Synthetic Monitoring HTTP checks for Mento production endpoints.
#
# The checks only record results: `probe_success`, `probe_duration_seconds` and
# `sm_check_info` land in grafanacloud-prom, where the Hardin SRE agent and the
# `dashboard-availability` SLO in alerts/slo/slos.yaml read them. They create no
# alert rule and page nobody; Synthetic Monitoring's own alerting stays off
# (`alert_sensitivity`).
#
# Budget: 5 checks x 2 probe locations x one run every 5 minutes is about
# 86,400 executions a month. Check the account plan before adding targets,
# locations or a shorter frequency.
#
# Bootstrap: the Synthetic Monitoring app is already initialised on the
# clabsmento stack (plugin apiHost below). The provider still needs a Synthetic
# Monitoring access token, which only a stack admin can generate in the UI.
# Until the `TF_VAR_SYNTHETIC_MONITORING_ACCESS_TOKEN` secret exists, the token
# is empty and this file manages nothing, so PR plans, applies and drift plans
# keep working.

locals {
  # The token value never leaves the provider; only whether it is set drives
  # resource count, so exposing that boolean is safe.
  synthetic_monitoring_enabled = nonsensitive(var.synthetic_monitoring_access_token != "")

  # Public probe locations: one in Europe, one in the US. Indexing a missing
  # name fails the plan instead of silently dropping a location.
  synthetic_probe_names = ["Frankfurt", "NorthVirginia"]

  # Keys become the Synthetic Monitoring job name (the `job` label on
  # probe_success). Keep them stable: the SLO query and Hardin's reads key on
  # job + instance.
  synthetic_http_checks = {
    "app-mento-org" = {
      target  = "https://app.mento.org"
      service = "frontend-app-mento-org"
    }
    "reserve-mento-org" = {
      target  = "https://reserve.mento.org"
      service = "frontend-reserve-mento-org"
    }
    "governance-mento-org" = {
      target  = "https://governance.mento.org"
      service = "frontend-governance-mento-org"
    }
    "ui-dashboard" = {
      target  = "https://monitoring.mento.org"
      service = "ui-dashboard"
    }
    # Liveness only. The endpoint answers 200 with `"status":"error"` while
    # any dependency check fails, and SENTRY_DSN is unset in production, so a
    # body match would fail permanently.
    "mento-analytics-api" = {
      target  = "https://mento-analytics-api-12390052758.us-central1.run.app/api/v1/health"
      service = "mento-analytics-api"
    }
  }
}

data "grafana_synthetic_monitoring_probes" "public" {
  count = local.synthetic_monitoring_enabled ? 1 : 0
}

resource "grafana_synthetic_monitoring_check" "http" {
  for_each = local.synthetic_monitoring_enabled ? local.synthetic_http_checks : {}

  job               = each.key
  target            = each.value.target
  enabled           = true
  frequency         = 300000 # 5 minutes
  timeout           = 10000  # 10 seconds
  alert_sensitivity = "none"
  probes = [
    for name in local.synthetic_probe_names : data.grafana_synthetic_monitoring_probes.public[0].probes[name]
  ]

  labels = {
    service     = each.value.service
    environment = "production"
  }

  settings {
    http {
      method             = "GET"
      ip_version         = "V4"
      valid_status_codes = [200]
      fail_if_not_ssl    = true
    }
  }
}
