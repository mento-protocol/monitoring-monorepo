# Aegis service-health alert rules (issue #706).
#
# Relocated from `aegis/terraform/aegis-service-alerts.tf` into this v3 module
# so all per-service health rules live together (cf. rules-indexer.tf,
# rules-metrics-bridge.tf). These are Aegis-service liveness checks (RPC error
# rate + staleness), NOT protocol deviation rules.
#
# Delivery is via the global notification policy (notification-policies.tf
# already routes service=aegis/severity=page → Splunk On-Call + #alerts-critical),
# so — like rules-trading-limits.tf / rules-oracle-relayers.tf / rules-reserve-
# balances.tf / rules-trading-modes.tf — there are deliberately NO per-rule
# `notification_settings` blocks. Adding them would double-fire.
#
# CROSS-STACK MOVE — this resource must be `terraform import`ed into the
# alerts-rules state (adopting the EXISTING Grafana object the aegis stack
# owns today) so the plan is a no-op, BEFORE the aegis stack drops it (#706
# PR2). The rule bodies below — name, folder, model JSON, conditions, labels,
# annotations — are copied VERBATIM from the source so the import is 0-diff.
# The only normalization is `datasource_uid = var.prometheus_datasource_uid`
# (default "grafanacloud-prom" — value-identical to the source literal) to
# match this module's convention; the `__expr__` datasources stay literal.
# The folder stays the Aegis folder (owned by the aegis stack, referenced here
# as a data source) so the Aegis dashboard keeps pointing at it.

resource "grafana_rule_group" "aegis_service_alerts" {
  name             = "Aegis service alerts"
  folder_uid       = data.grafana_folder.aegis.uid
  interval_seconds = 60

  rule {
    name      = "Number of failed rpc calls"
    condition = "B"

    data {
      ref_id = "errorCount"

      relative_time_range {
        from = 300
        to   = 0
      }

      datasource_uid = var.prometheus_datasource_uid
      model          = "{\"disableTextWrap\":false,\"editorMode\":\"code\",\"expr\":\"sum(increase(view_call_query_duration_count{status=\\\"error\\\"}[5m]))\",\"fullMetaSearch\":false,\"includeNullMetadata\":true,\"instant\":true,\"intervalMs\":600000,\"legendFormat\":\"__auto\",\"maxDataPoints\":43200,\"range\":false,\"refId\":\"errorCount\",\"useBackend\":false}"
    }
    data {
      ref_id = "B"

      relative_time_range {
        from = 300
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[10,0],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[]},\"reducer\":{\"params\":[],\"type\":\"avg\"},\"type\":\"query\"}],\"datasource\":{\"name\":\"Expression\",\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"errorCount\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"B\",\"type\":\"threshold\"}"
    }

    no_data_state  = "OK"
    exec_err_state = "Error"
    for            = "5m"
    annotations = {
      description = "Tracks the number of error responses from our monitoring service."
      summary     = "More than 10 errors were detected in a 5-minute timespan."
    }
    labels = {
      service  = "aegis"
      severity = "page"
    }
    is_paused = false
  }
  rule {
    name      = "Aegis does not report new data"
    condition = "C"

    data {
      ref_id = "A"

      relative_time_range {
        from = 600
        to   = 0
      }

      datasource_uid = var.prometheus_datasource_uid
      model          = "{\"editorMode\":\"code\",\"expr\":\"time() - lastUpdatedAt\",\"instant\":true,\"intervalMs\":1000,\"legendFormat\":\"__auto\",\"maxDataPoints\":43200,\"range\":false,\"refId\":\"A\"}"
    }
    data {
      ref_id = "C"

      relative_time_range {
        from = 600
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[300],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"C\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"A\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"C\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Error"
    for            = "5m"
    annotations = {
      description = "Triggers if the time between the last aegis update and now is bigger than 5 mins."
      summary     = "Tracks the time passed since the last update from aegis. \n\nThis alert triggering means aegis did not push any new data for > 5mins.\n\nIt is highly possible that the aegis is down."
    }
    labels = {
      service  = "aegis"
      severity = "page"
    }
    is_paused = false
  }
}
