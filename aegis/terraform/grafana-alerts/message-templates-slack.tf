# Slack mrkdwn message templates per Aegis alertname.
# Selected by the `local.alert_config_slack` dispatcher in locals.tf.

resource "grafana_message_template" "slack_oracle_stale_price_alert_title" {
  name     = "Slack: Stale Price Alert Title"
  template = <<-EOT
{{ define "slack.oracle_stale_price_alert_title" }}
[{{ if (len .Alerts.Firing) }}{{ len .Alerts.Firing }} FIRING{{ end }}{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end }}{{ if (len .Alerts.Resolved) }}{{ len .Alerts.Resolved }} RESOLVED{{ end }}] {{ .CommonLabels.alertname }}
{{ if (len .Alerts.Firing) }}Firing: {{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end }}{{ $alert.Labels.rateFeed }} on {{ $alert.Labels.chain | title }}{{ end }}{{ end }}
{{ if (len .Alerts.Resolved) }}Resolved: {{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end }}{{ $alert.Labels.rateFeed }} on {{ $alert.Labels.chain | title }}{{ end }}{{ end }}
{{ end }}
EOT
}


resource "grafana_message_template" "slack_oracle_stale_price_alert_message" {
  name     = "Slack: Stale Price Alert Message"
  template = <<-EOT
{{ define "slack.oracle_stale_price_alert_message" }}
{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ range .Alerts.Firing }}
*🚨 FIRING: Stale price for {{ .Labels.rateFeed }} rate feed on {{ .Labels.chain | title }}*
1. Check the latest transactions of the {{ .Labels.rateFeed }} relayer on {{ .Labels.chain | title }}
2. Check if the relayer cloud function is still being triggered regularly
{{ end }}
{{ range .Alerts.Resolved }}
*✅ RESOLVED: Price is fresh again for {{ .Labels.rateFeed }} rate feed on {{ .Labels.chain }}*
{{ end }}
{{ end }}
EOT
}

resource "grafana_message_template" "slack_oracle_relayer_low_balance_alert_title" {
  name     = "Slack: Low Relayer Balance Alert Title"
  template = <<-EOT
{{ define "slack.oracle_relayer_low_balance_alert_title" }}{{ if (len .Alerts.Firing) }}🔴{{ else }}✅{{ end }}{{ end }}
EOT
}


resource "grafana_message_template" "slack_oracle_relayer_low_balance_alert_message" {
  name     = "Slack: Low Relayer Balance Alert Message"
  template = <<-EOT
{{ define "slack.oracle_relayer_low_balance_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $pair := reReplaceAll "^RelayerSigner([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.owner -}}
*<https://{{ .Labels.explorer }}/address/{{ .Labels.ownerValue }}|Low {{ .Labels.token }} balance for {{ $pair }} Relayer on {{ .Labels.chain | title }}> — {{ .Annotations.currentBalance }} {{ .Labels.token }} left*
- Top up the <https://{{ .Labels.explorer }}/address/{{ .Labels.ownerValue }}|relayer wallet> to keep the relayer running
- Run the <https://github.com/mento-protocol/oracle-relayer?tab=readme-ov-file#refilling-relayer-signer-accounts|relayer refill script>, or send 50 {{ .Labels.token }} from the dev wallet
- Get the dev wallet private key from the Eng vault in 1Password

{{ end -}}
{{ range .Alerts.Resolved -}}
{{ $pair := reReplaceAll "^RelayerSigner([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.owner -}}
*<https://{{ .Labels.explorer }}/address/{{ .Labels.ownerValue }}|Sufficient {{ .Labels.token }} balance restored for the {{ $pair }} Relayer on {{ .Labels.chain | title }}> — {{ .Annotations.currentBalance }} {{ .Labels.token }}*
{{ end -}}
{{ end }}
EOT
}

resource "grafana_message_template" "slack_reserve_balance_alert_title" {
  name     = "Slack: Reserve Balance Alert Title"
  template = <<-EOT
{{ define "slack.reserve_balance_alert_title" }}{{ if (len .Alerts.Firing) }}🔴{{ else }}✅{{ end }}{{ end }}
EOT
}

resource "grafana_message_template" "slack_reserve_balance_alert_message" {
  name     = "Slack: Reserve Balance Alert Message"
  template = <<-EOT
{{ define "slack.reserve_balance_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $token := .Labels.token -}}
{{ $reserveAddress := .Labels.ownerValue -}}
*<https://celoscan.io/address/{{ $reserveAddress }}|Low {{ $token }} balance in the {{ .Labels.owner }}> — {{ .Annotations.currentBalance }} left*
- Top up the {{ .Labels.owner }} above the alert threshold of {{ .Annotations.threshold }} {{ $token }}
{{ end -}}
{{ range .Alerts.Resolved -}}
{{ $token := .Labels.token -}}
{{ $reserveAddress := .Labels.ownerValue -}}
*<https://celoscan.io/address/{{ $reserveAddress }}|Sufficient {{ $token }} balance restored in the {{ .Labels.owner }}> — {{ .Annotations.currentBalance }}*
{{ end -}}
{{ end }}
EOT
}

resource "grafana_message_template" "slack_trading_mode_alert_title" {
  name     = "Slack: Trading Mode Alert Title"
  template = <<-EOT
  {{ define "slack.trading_mode_alert_title" }}
  [{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
  {{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
  {{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
  {{ end -}}
  EOT
}

resource "grafana_message_template" "slack_trading_mode_alert_message" {
  name     = "Slack: Trading Mode Alert Message"
  template = <<-EOT
{{ define "slack.trading_mode_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $rateFeedWithHyphen := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1-$2" .Labels.rateFeed -}}
{{ $chain := .Labels.chain | title -}}
*🚨 Trading halted for <{{ .GeneratorURL }}&tab=instances|{{ .Labels.rateFeed }}> on {{ $chain }}*{{ if eq $chain "Celo" }}
- Check the <https://dune.com/mento-labs-eng/circuit-breakers|Circuit Breaker Dashboard> for tripped breakers
- Check the <https://data.chain.link/feeds/celo/mainnet/{{ $rateFeedWithHyphen }}|Chainlink feed> for volatility around the alert time{{ end }}
{{ end -}}

{{ range .Alerts.Resolved -}}
{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
{{ $chain := .Labels.chain | title -}}
- *✅ Trading resumed for {{ $rateFeedWithSlash }} on {{ $chain }}*
{{ end -}}

{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing 🙂.{{ end }}
{{ end -}}
EOT
}

resource "grafana_message_template" "slack_trading_limits_alert_title" {
  name     = "Slack: Trading Limits Alert Title"
  template = <<-EOT
  {{ define "slack.trading_limits_alert_title" }}
  [{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
  {{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
  {{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
  {{ end -}}
  EOT
}

resource "grafana_message_template" "slack_trading_limits_alert_message" {
  name     = "Slack: Trading Limits Alert Message"
  template = <<-EOT
{{ define "slack.trading_limits_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $chain := .Labels.chain | title -}}
{{ $limitType := .Labels.limitType -}}
*🚨 Trading Limit {{ $limitType }} at {{ with index .Values "utilization" }}{{ . }}{{ else }}unknown{{ end }}% for <{{ .GeneratorURL }}&tab=instances|{{ .Labels.limitId }}> on {{ $chain }}*
- Current utilization: {{ with index .Values "utilization" }}{{ . }}{{ else }}unknown{{ end }}%
- Limit Type: {{ $limitType }}{{ if eq $limitType "L0" }} - short-term (5 minutes){{ else if eq $limitType "L1" }} - medium-term (daily){{ else if eq $limitType "LG" }} - global (has to be manually reset){{ end }}{{ if or (eq $limitType "L1") (eq $limitType "LG") }}
- *Action Required*: This is a {{ if eq $limitType "L1" }}medium-term (daily){{ else }}lifetime{{ end }} limit breach{{ end }}
{{ end -}}

{{ range .Alerts.Resolved -}}
{{ $chain := .Labels.chain | title -}}
{{ $limitType := .Labels.limitType -}}
- *✅ Trading Limit {{ $limitType }} resolved for {{ .Labels.limitId }} on {{ $chain }}*
{{ end -}}

{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing 🙂.{{ end }}
{{ end -}}
EOT
}

resource "grafana_message_template" "slack_aegis_service_alert_title" {
  name     = "Slack: Aegis Service Alert Title"
  template = <<-EOT
{{ define "slack.aegis_service_alert_title" }}
[{{ if (len .Alerts.Firing) }}{{ len .Alerts.Firing }} FIRING{{ end }}{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end }}{{ if (len .Alerts.Resolved) }}{{ len .Alerts.Resolved }} RESOLVED{{ end }}] {{ .CommonLabels.alertname }}
{{ if (len .Alerts.Firing) }}Firing: {{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end }}{{ $alert.Labels.alertname }}{{ end }}{{ end }}
{{ if (len .Alerts.Resolved) }}Resolved: {{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end }}{{ $alert.Labels.alertname }}{{ end }}{{ end }}
{{ end }}
EOT
}

resource "grafana_message_template" "slack_aegis_service_alert_message" {
  name     = "Slack: Aegis Service Alert Message"
  template = <<-EOT
{{ define "slack.aegis_service_alert_message" }}
{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ range .Alerts.Firing }}
{{ if eq .Labels.alertname "Number of failed rpc calls" }}
*🚨 FIRING: High number of failed RPC calls detected*
- More than 10 errors were detected in a 5-minute timespan
- Check the Aegis service logs for potential issues via `pnpm aegis:logs`
- Verify RPC endpoint connectivity and stability
{{ else if eq .Labels.alertname "Aegis does not report new data" }}
*🚨 FIRING: Aegis service is not reporting new data*
- Aegis has not pushed any new data for more than 5 minutes
- The service may be down or experiencing issues
- Check Aegis service status and logs immediately
{{ else }}
*🚨 FIRING: {{ .Labels.alertname }}*
{{ .Annotations.summary }}
{{ end }}
{{ end }}
{{ range .Alerts.Resolved }}
{{ if eq .Labels.alertname "Number of failed rpc calls" }}
*✅ RESOLVED: RPC call failures have decreased*
- The number of failed RPC calls is now within acceptable limits
{{ else if eq .Labels.alertname "Aegis does not report new data" }}
*✅ RESOLVED: Aegis service is reporting data again*
- Aegis has resumed normal data reporting
{{ else }}
*✅ RESOLVED: {{ .Labels.alertname }}*
{{ end }}
{{ end }}
{{ end }}
EOT
}
