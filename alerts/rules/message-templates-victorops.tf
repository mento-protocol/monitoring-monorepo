# Plain-text message templates per Aegis alertname for Splunk On-Call.
# VictorOps renders raw text — no markdown survives. Selected by the
# `local.alert_config_victorops` dispatcher in locals.tf.

resource "grafana_message_template" "victorops_oracle_stale_price_alert_title" {
  name     = "VictorOps: Stale Price Alert Title"
  template = <<-EOT
{{ define "victorops.oracle_stale_price_alert_title" }}
[{{ if (len .Alerts.Firing) }}{{ len .Alerts.Firing }} FIRING{{ end }}{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end }}{{ if (len .Alerts.Resolved) }}{{ len .Alerts.Resolved }} RESOLVED{{ end }}] {{ .CommonLabels.alertname }}
{{ if (len .Alerts.Firing) }}Firing: {{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end }}{{ $alert.Labels.rateFeed }} on {{ $alert.Labels.chain | title }}{{ end }}{{ end }}
{{ if (len .Alerts.Resolved) }}Resolved: {{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end }}{{ $alert.Labels.rateFeed }} on {{ $alert.Labels.chain | title }}{{ end }}{{ end }}
{{ end }}
EOT
}


resource "grafana_message_template" "victorops_oracle_stale_price_alert_message" {
  name     = "VictorOps: Stale Price Alert Message"
  template = <<-EOT
{{ define "victorops.oracle_stale_price_alert_message" }}
{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ range .Alerts.Firing }}
FIRING: Stale price for {{ .Labels.rateFeed }} rate feed on {{ .Labels.chain | title }}
1. Check the latest transactions of the {{ .Labels.rateFeed }} relayer on {{ .Labels.chain | title }}
2. Check if the relayer cloud function is still being triggered regularly
{{ end }}
{{ range .Alerts.Resolved }}
RESOLVED: Price is fresh again for {{ .Labels.rateFeed }} rate feed on {{ .Labels.chain }}
{{ end }}
{{ end }}
EOT
}

resource "grafana_message_template" "victorops_oracle_relayer_low_balance_alert_title" {
  name     = "VictorOps: Low Relayer Balance Alert Title"
  template = <<-EOT
{{ define "victorops.oracle_relayer_low_balance_alert_title" }}Low Relayer Balance{{ end }}
EOT
}


resource "grafana_message_template" "victorops_oracle_relayer_low_balance_alert_message" {
  name     = "VictorOps: Low Relayer Balance Alert Message"
  template = <<-EOT
{{ define "victorops.oracle_relayer_low_balance_alert_message" }}
{{ range .Alerts.Firing }}
{{ $pair := reReplaceAll "^RelayerSigner([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.owner }}
Low {{ .Labels.token }} balance for {{ $pair }} Relayer on {{ .Labels.chain | title }} — {{ .Annotations.currentBalance }} {{ .Labels.token }} left
Wallet: https://{{ .Labels.explorer }}/address/{{ .Labels.ownerValue }}
- Top up the relayer wallet to keep the relayer running
- Run the relayer refill script (https://github.com/mento-protocol/oracle-relayer?tab=readme-ov-file#refilling-relayer-signer-accounts), or send 50 {{ .Labels.token }} from the dev wallet
- Get the dev wallet private key from the Eng vault in 1Password
{{ end }}
{{ range .Alerts.Resolved }}
{{ $pair := reReplaceAll "^RelayerSigner([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.owner }}
Sufficient {{ .Labels.token }} balance restored for the {{ $pair }} Relayer on {{ .Labels.chain | title }} — {{ .Annotations.currentBalance }} {{ .Labels.token }}
{{ end }}
{{ end }}
EOT
}

resource "grafana_message_template" "victorops_reserve_balance_alert_title" {
  name     = "VictorOps: Reserve Balance Alert Title"
  template = <<-EOT
  {{ define "victorops.reserve_balance_alert_title" }}
  [{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
  {{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
  {{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
  {{ end -}}
  EOT
}

resource "grafana_message_template" "victorops_reserve_balance_alert_message" {
  name     = "VictorOps: Reserve Balance Alert Message"
  template = <<-EOT
  {{ define "victorops.reserve_balance_alert_message" }}
  {{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
  {{ range .Alerts.Firing -}}
  {{ $token := .Labels.token -}}
  {{ $reserveAddress := .Labels.ownerValue -}}
FIRING: Low {{ $token }} balance — {{ .Annotations.currentBalance }} left
Please top up the {{ $token }} balance of the {{ .Labels.owner }} ({{ $reserveAddress }}) above the alert threshold of {{ .Annotations.threshold }} {{ $token }}. Address: https://celoscan.io/address/{{ $reserveAddress }}
{{ if .GeneratorURL -}}Grafana Alert Link: {{ .GeneratorURL }}{{- end }}
  {{ end -}}
  {{ range .Alerts.Resolved -}}
  {{ $token := .Labels.token -}}
  {{ $reserveAddress := .Labels.ownerValue -}}
RESOLVED: Sufficient {{ $token }} balance restored for the {{ .Labels.owner }} ({{ $reserveAddress }}) — {{ .Annotations.currentBalance }}
  {{ end -}}
  {{ end -}}
  EOT
}

resource "grafana_message_template" "victorops_trading_mode_alert_title" {
  name     = "VictorOps: Trading Mode Alert Title"
  template = <<-EOT
  {{ define "victorops.trading_mode_alert_title" }}{{ if (len .Alerts.Firing) }}Trading halted{{ else }}Trading resumed{{ end }}{{ end -}}
  EOT
}

resource "grafana_message_template" "victorops_trading_mode_alert_message" {
  name     = "VictorOps: Trading Mode Alert Message"
  template = <<-EOT
{{ define "victorops.trading_mode_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
{{ $chain := .Labels.chain | title -}}
{{ $chainId := "" -}}
${local.chain_id_branches}
{{ $chainlinkFeedPath := "" -}}
${local.chainlink_feed_path_branches}
{{ $pool := "" -}}
{{ $chainlinkSlug := "" -}}
{{ if eq .Labels.chain "celo" -}}
${local.celo_pool_branches}
${local.celo_chainlink_slug_branches}
{{ end -}}
{{ if eq .Labels.chain "monad" -}}
${local.monad_pool_branches}
${local.monad_chainlink_slug_branches}
{{ end -}}
{{ $poolURL := printf "%s&tab=instances" .GeneratorURL -}}
{{ if and $chainId $pool -}}{{ $poolURL = printf "https://monitoring.mento.org/pool/%s-%s?tab=oracle" $chainId $pool }}{{ end -}}
Trading halted for {{ $rateFeedWithSlash }} on {{ $chain }}
- Check for tripped breakers on the {{ if $pool }}{{ $rateFeedWithSlash }} pool{{ else }}alert details{{ end }}: {{ $poolURL }}{{ if and $chainlinkFeedPath $chainlinkSlug }}
- Check the Chainlink feed for volatility around the alert time at {{ .StartsAt.Format "Mon Jan 02 15:04 UTC" }}: https://data.chain.link/feeds/{{ $chainlinkFeedPath }}/{{ $chainlinkSlug }}{{ end }}
{{ end -}}

{{ range .Alerts.Resolved -}}
{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
{{ $chain := .Labels.chain | title -}}
Trading resumed for {{ $rateFeedWithSlash }} on {{ $chain }}
{{ end -}}

{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ end -}}
EOT
}

resource "grafana_message_template" "victorops_trading_limits_alert_title" {
  name     = "VictorOps: Trading Limits Alert Title"
  template = <<-EOT
  {{ define "victorops.trading_limits_alert_title" }}
  [{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
  {{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
  {{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
  {{ end -}}
  EOT
}

resource "grafana_message_template" "victorops_trading_limits_alert_message" {
  name     = "VictorOps: Trading Limits Alert Message"
  template = <<-EOT
{{ define "victorops.trading_limits_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $chain := .Labels.chain | title -}}
{{ $limitType := .Labels.limitType -}}
Trading Limit {{ $limitType }} at {{ with index .Values "utilization" }}{{ . }}{{ else }}unknown{{ end }}% for {{ .Labels.limitId }} on {{ $chain }} — {{ .GeneratorURL }}&tab=instances
- Current utilization: {{ with index .Values "utilization" }}{{ . }}{{ else }}unknown{{ end }}%
- Limit Type: {{ $limitType }}{{ if eq $limitType "L0" }} - short-term (5 minutes){{ else if eq $limitType "L1" }} - medium-term (daily){{ else if eq $limitType "LG" }} - global (has to be manually reset){{ end }}{{ if or (eq $limitType "L1") (eq $limitType "LG") }}
- Action Required: This is a {{ if eq $limitType "L1" }}medium-term (daily){{ else }}lifetime{{ end }} limit breach{{ end }}
{{ end -}}

{{ range .Alerts.Resolved -}}
{{ $chain := .Labels.chain | title -}}
{{ $limitType := .Labels.limitType -}}
- RESOLVED: Trading Limit {{ $limitType }} resolved for {{ .Labels.limitId }} on {{ $chain }}
{{ end -}}

{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ end -}}
EOT
}

resource "grafana_message_template" "victorops_aegis_service_alert_title" {
  name     = "VictorOps: Aegis Service Alert Title"
  template = <<-EOT
{{ define "victorops.aegis_service_alert_title" }}
[{{ if (len .Alerts.Firing) }}{{ len .Alerts.Firing }} FIRING{{ end }}{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end }}{{ if (len .Alerts.Resolved) }}{{ len .Alerts.Resolved }} RESOLVED{{ end }}] {{ .CommonLabels.alertname }}
{{ if (len .Alerts.Firing) }}Firing: {{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end }}{{ $alert.Labels.alertname }}{{ end }}{{ end }}
{{ if (len .Alerts.Resolved) }}Resolved: {{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end }}{{ $alert.Labels.alertname }}{{ end }}{{ end }}
{{ end }}
EOT
}

resource "grafana_message_template" "victorops_aegis_service_alert_message" {
  name     = "VictorOps: Aegis Service Alert Message"
  template = <<-EOT
{{ define "victorops.aegis_service_alert_message" }}
{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ range .Alerts.Firing }}
{{ if eq .Labels.alertname "Number of failed rpc calls" }}
FIRING: High number of failed RPC calls detected
- More than 10 errors were detected in a 5-minute timespan
- Check the Aegis service logs for potential issues via `pnpm aegis:logs`
- Verify RPC endpoint connectivity and stability
{{ else if eq .Labels.alertname "Aegis does not report new data" }}
FIRING: Aegis service is not reporting new data
- Aegis has not pushed any new data for more than 5 minutes
- The service may be down or experiencing issues
- Check Aegis service status and logs immediately
{{ else }}
FIRING: {{ .Labels.alertname }}
{{ .Annotations.summary }}
{{ end }}
{{ end }}
{{ range .Alerts.Resolved }}
{{ if eq .Labels.alertname "Number of failed rpc calls" }}
RESOLVED: RPC call failures have decreased
- The number of failed RPC calls is now within acceptable limits
{{ else if eq .Labels.alertname "Aegis does not report new data" }}
RESOLVED: Aegis service is reporting data again
- Aegis has resumed normal data reporting
{{ else }}
RESOLVED: {{ .Labels.alertname }}
{{ end }}
{{ end }}
{{ end }}
EOT
}
