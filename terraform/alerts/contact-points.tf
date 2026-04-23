# Slack contact points routed via rule-level `notification_settings`, NOT via
# the root `grafana_notification_policy` (which is owned by the Aegis repo as a
# singleton resource — see aegis/terraform/grafana-alerts/notification-policies.tf).
#
# Bypassing the policy tree means:
#   - No cross-repo coordination needed to ship v3 alerts.
#   - v3 alerts' group/repeat timings are set per-rule below, not inherited.
#   - Future per-domain splits (fpmms/oracles/cdps) can stay in this repo.

resource "grafana_contact_point" "slack_critical" {
  name = "slack-alerts-critical"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_critical
    title     = "{{ if eq .Status \"firing\" }}🔴{{ else }}✅{{ end }} [{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}"
    text      = <<-EOT
      {{ range .Alerts -}}
      *Service:* `{{ .Labels.service }}`
      {{ if .Labels.pool_id -}}
      *Pool:* `{{ .Labels.pair }}` on `{{ .Labels.chain_id }}`
      *Pool ID:* `{{ .Labels.pool_id }}`
      {{ end -}}
      *Severity:* {{ .Labels.severity }}
      {{ if .Annotations.summary }}*Summary:* {{ .Annotations.summary }}{{ end }}
      {{ if .Annotations.description }}{{ .Annotations.description }}{{ end }}
      *Started:* {{ .StartsAt.Format "2006-01-02 15:04:05 UTC" }}
      {{ if .GeneratorURL }}<{{ .GeneratorURL }}|View in Grafana>{{ end }}
      {{ end }}
    EOT
  }
}

resource "grafana_contact_point" "slack_warnings" {
  name = "slack-alerts-warnings"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_warnings
    title     = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }} [{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}"
    text      = <<-EOT
      {{ range .Alerts -}}
      *Service:* `{{ .Labels.service }}`
      {{ if .Labels.pool_id -}}
      *Pool:* `{{ .Labels.pair }}` on `{{ .Labels.chain_id }}`
      *Pool ID:* `{{ .Labels.pool_id }}`
      {{ end -}}
      *Severity:* {{ .Labels.severity }}
      {{ if .Annotations.summary }}*Summary:* {{ .Annotations.summary }}{{ end }}
      {{ if .Annotations.description }}{{ .Annotations.description }}{{ end }}
      *Started:* {{ .StartsAt.Format "2006-01-02 15:04:05 UTC" }}
      {{ if .GeneratorURL }}<{{ .GeneratorURL }}|View in Grafana>{{ end }}
      {{ end }}
    EOT
  }
}

locals {
  # Group/repeat timings applied via notification_settings on every v3 rule.
  # Aegis root policy uses 30s/5m/4h for catch-all; v3 shortens repeat to 1h so
  # unacknowledged pages don't go silent overnight.
  notify_critical = {
    contact_point   = grafana_contact_point.slack_critical.name
    group_by        = ["alertname", "grafana_folder", "chain_id", "pool_id"]
    group_wait      = "30s"
    group_interval  = "5m"
    repeat_interval = "1h"
  }

  notify_warning = {
    contact_point   = grafana_contact_point.slack_warnings.name
    group_by        = ["alertname", "grafana_folder", "chain_id", "pool_id"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }
}
