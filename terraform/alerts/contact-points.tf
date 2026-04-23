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
    title     = "{{ if eq .Status \"firing\" }}🔴{{ else }}✅{{ end }} {{ .CommonLabels.alertname }}{{ if .CommonLabels.pair }} — {{ .CommonLabels.pair }}{{ end }}{{ if .CommonLabels.chain_name }} · {{ .CommonLabels.chain_name | title }}{{ end }}"
    text      = local.slack_body_template
  }
}

resource "grafana_contact_point" "slack_warnings" {
  name = "slack-alerts-warnings"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_warnings
    title     = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }} {{ .CommonLabels.alertname }}{{ if .CommonLabels.pair }} — {{ .CommonLabels.pair }}{{ end }}{{ if .CommonLabels.chain_name }} · {{ .CommonLabels.chain_name | title }}{{ end }}"
    text      = local.slack_body_template
  }
}

locals {
  # Shared message body — both contact points (critical + warnings) render the
  # same structure so operators can't mistake fields between channels.
  #
  # Title carries identity (alertname — pair · chain). Body is:
  #   1. One-line headline from the rule's `summary` annotation.
  #   2. Italicised `description` with likely causes, if present.
  #   3. Metadata row: clickable pool address (→ block explorer) + start time.
  #   4. Action row: dashboard link + Grafana alert link.
  #
  # For metrics-bridge alerts (no pool_id/pair/chain), the pool/dashboard
  # blocks are suppressed via `{{ if .Labels.pool_id }}`.
  slack_body_template = <<-EOT
    {{ range .Alerts -}}
    {{ if .Annotations.summary }}{{ .Annotations.summary }}
    {{ end -}}
    {{ if .Annotations.description }}_{{ .Annotations.description }}_
    {{ end }}
    {{ if .Labels.pool_id -}}
    *Pool:* {{ if .Labels.block_explorer_url }}<{{ .Labels.block_explorer_url }}|`{{ .Labels.pool_address_short }}`>{{ else }}`{{ .Labels.pool_address_short }}`{{ end }}   *Started:* {{ .StartsAt.Format "15:04 UTC" }}
    <https://monitoring.mento.org/pool/{{ .Labels.pool_id }}|Open pool>   ·   <{{ .GeneratorURL }}|View alert>
    {{ else -}}
    *Started:* {{ .StartsAt.Format "15:04 UTC" }}   ·   <{{ .GeneratorURL }}|View alert>
    {{ end -}}
    {{ end }}
  EOT

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
