provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_service_account_token
}

# One folder per `service` label — same split as the Aegis convention
# (Oracle Relayers / Reserve / Trading Modes / Trading Limits are each their
# own folder). Future `oracles` + `cdps` folders land when those rule groups
# do; empty folders aren't created preemptively.
resource "grafana_folder" "fpmms" {
  title = "FPMMs"
  uid   = "mento-fpmms"
}

resource "grafana_folder" "metrics_bridge" {
  title = "Metrics Bridge"
  uid   = "mento-metrics-bridge"
}

locals {
  # Common evaluation window for instant queries. 10 minutes is enough to absorb
  # one missed scrape (30s) and still produce a fresh value on every 60s eval.
  instant_query_range_seconds = 600
}
