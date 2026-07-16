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
# CROSS-STACK MOVE — this resource was `terraform import`ed into the
# alerts-rules state in #706, then removed from the aegis stack state. The
# folder stays the Aegis folder (owned by the aegis stack, referenced here by
# its externally owned UID) so the Aegis dashboard keeps pointing at it.

resource "grafana_rule_group" "aegis_service_alerts" {
  name             = "Aegis service alerts"
  folder_uid       = local.external_folder_uids.aegis
  interval_seconds = 60

  rule {
    name      = "Aegis view-call failures [production]"
    condition = "B"

    data {
      ref_id = "errorCount"

      relative_time_range {
        from = 300
        to   = 0
      }

      datasource_uid = var.prometheus_datasource_uid
      model = jsonencode({
        disableTextWrap = false
        editorMode      = "code"
        # Testnet poll errors have warning-only rules in rules-aegis-testnet.tf.
        # Keep this page scoped to production and preserve the failing call
        # labels so the on-call can see what broke without digging first.
        expr                = "sum by (chain, contract, functionName) (increase(view_call_query_duration_count{chain=~\"^(celo|monad|polygon)$\",status=\"error\"}[5m]))"
        fullMetaSearch      = false
        includeNullMetadata = true
        instant             = true
        intervalMs          = 600000
        legendFormat        = "__auto"
        maxDataPoints       = 43200
        range               = false
        refId               = "errorCount"
        useBackend          = false
      })
    }
    data {
      ref_id = "B"

      relative_time_range {
        from = 300
        to   = 0
      }

      datasource_uid = "__expr__"
      model = jsonencode({
        refId         = "B"
        type          = "threshold"
        expression    = "errorCount"
        intervalMs    = 1000
        maxDataPoints = 43200
        conditions = [{
          evaluator = { params = [10, 0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = [] }
          reducer   = { params = [], type = "avg" }
          type      = "query"
        }]
        datasource = { name = "Expression", type = "__expr__", uid = "__expr__" }
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"
    for            = "5m"
    annotations = {
      description = "Aegis failed to read {{ $labels.contract }}.{{ $labels.functionName }} on {{ $labels.chain }}. These view calls feed protocol monitoring metrics; sustained failures can delay or suppress downstream alerts."
      summary     = "Aegis recorded more than 10 failed production view-call samples for {{ $labels.contract }}.{{ $labels.functionName }} on {{ $labels.chain }} in 5 minutes."
    }
    labels = {
      service  = "aegis"
      severity = "page"
    }
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
      model = jsonencode({
        refId         = "A"
        expr          = "time() - lastUpdatedAt"
        editorMode    = "code"
        instant       = true
        intervalMs    = 1000
        legendFormat  = "__auto"
        maxDataPoints = 43200
        range         = false
      })
    }
    data {
      ref_id = "C"

      relative_time_range {
        from = 600
        to   = 0
      }

      datasource_uid = "__expr__"
      model = jsonencode({
        refId         = "C"
        type          = "threshold"
        expression    = "A"
        intervalMs    = 1000
        maxDataPoints = 43200
        conditions = [{
          evaluator = { params = [300], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
      })
    }

    # This is the liveness rule: if the heartbeat series disappears entirely,
    # absence of data is the signal rather than noise.
    no_data_state  = "Alerting"
    exec_err_state = "Error"
    for            = "5m"
    annotations = {
      description = "Aegis has not pushed any new metrics for more than 5 minutes. Protocol alert inputs may be stale."
      summary     = "Aegis data reporting is stale. Check App Engine service health and Aegis logs immediately."
    }
    labels = {
      service  = "aegis"
      severity = "page"
    }
  }
}
