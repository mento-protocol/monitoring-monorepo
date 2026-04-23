provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_service_account_token
}

# Single folder holds all v3 FPMM + metrics-bridge alert rule groups.
# Named to match the `service =~ "fpmms|oracles|cdps|metrics-bridge"` namespace
# reserved in docs/SPEC.md §10.
resource "grafana_folder" "v3_alerts" {
  title = "Mento v3 Alerts"
  uid   = "mento-v3-alerts"
}

locals {
  # Common evaluation window for instant queries. 10 minutes is enough to absorb
  # one missed scrape (30s) and still produce a fresh value on every 60s eval.
  instant_query_range_seconds = 600
}
