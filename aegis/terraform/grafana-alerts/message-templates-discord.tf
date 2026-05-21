# All Discord message templates bundled into one grafana_message_template
# resource. Grafana's template registry indexes `{{ define "name" }}` blocks
# globally across all provisioned templates, so the dispatcher in
# `locals.tf:alert_config` resolves `{{ template "discord.X_alert_*" }}`
# references the same way whether each `define` lives in its own resource
# or in this combined one.
#
# Bundled to stay within Grafana Cloud's per-stack `alerting.notifications.
# templates.limitExceeded` cap (currently 30) — the migration's Slack +
# VictorOps families add 24 individual templates of their own, which would
# blow past the limit if Discord templates remained 1-resource-per-define.

resource "grafana_message_template" "discord" {
  name     = "Discord: All Alert Templates"
  template = <<-EOT
{{ define "discord.oracle_stale_price_alert_title" }}
[{{ if (len .Alerts.Firing) }}{{ len .Alerts.Firing }} FIRING{{ end }}{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end }}{{ if (len .Alerts.Resolved) }}{{ len .Alerts.Resolved }} RESOLVED{{ end }}] {{ .CommonLabels.alertname }}
{{ if (len .Alerts.Firing) }}Firing: {{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end }}{{ $alert.Labels.rateFeed }} on {{ $alert.Labels.chain | title }}{{ end }}{{ end }}
{{ if (len .Alerts.Resolved) }}Resolved: {{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end }}{{ $alert.Labels.rateFeed }} on {{ $alert.Labels.chain | title }}{{ end }}{{ end }}
{{ end }}

{{ define "discord.oracle_stale_price_alert_message" }}
{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ range .Alerts.Firing }}
**🚨 FIRING: Stale price for {{ .Labels.rateFeed }} rate feed on {{ .Labels.chain | title }}**
1. Check the latest transactions of the {{ .Labels.rateFeed }} relayer on {{ .Labels.chain | title }}
2. Check if the relayer cloud function is still being triggered regularly
{{ end }}
{{ range .Alerts.Resolved }}
**✅ RESOLVED: Price is fresh again for {{ .Labels.rateFeed }} rate feed on {{ .Labels.chain }}**
{{ end }}
{{ end }}

{{ define "discord.oracle_relayer_low_celo_balance_alert_title" }}{{ if (len .Alerts.Firing) }}🔴{{ else }}✅{{ end }}{{ end }}

{{ define "discord.oracle_relayer_low_celo_balance_alert_message" }}
{{ range .Alerts.Firing }}
{{ $pair := reReplaceAll "^RelayerSigner([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.owner }}
**[Low CELO balance for {{ $pair }} Relayer on {{ .Labels.chain | title }}](https://{{ if eq .Labels.chain "celo-sepolia" }}sepolia.{{ end }}celoscan.io/address/{{ .Labels.ownerValue }}) — {{ .Annotations.currentBalance }} CELO left**
- Top up the [relayer wallet](https://{{ if eq .Labels.chain "celo-sepolia" }}sepolia.{{ end }}celoscan.io/address/{{ .Labels.ownerValue }}) to keep the relayer running
- Run the [relayer refill script](https://github.com/mento-protocol/oracle-relayer?tab=readme-ov-file#refilling-relayer-signer-accounts), or send 50 CELO from the dev wallet
- Get the dev wallet private key from the Eng vault in 1Password
{{ end }}
{{ range .Alerts.Resolved }}
{{ $pair := reReplaceAll "^RelayerSigner([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.owner }}
**[Sufficient CELO balance restored for the {{ $pair }} Relayer on {{ .Labels.chain | title }}](https://{{ if eq .Labels.chain "celo-sepolia" }}sepolia.{{ end }}celoscan.io/address/{{ .Labels.ownerValue }}) — {{ .Annotations.currentBalance }} CELO**
{{ end }}
{{ end }}

{{ define "discord.reserve_balance_alert_title" }}
[{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
{{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
{{ end -}}

{{ define "discord.reserve_balance_alert_message" }}
{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ range .Alerts.Firing -}}
{{ $token := .Labels.token -}}
{{ $reserveAddress := .Labels.ownerValue -}}
**🚨 FIRING: Low {{ $token }} balance — {{ .Annotations.currentBalance }} left**
Please top up the {{ $token }} balance of the [{{ .Labels.owner }}](https://celoscan.io/address/{{ $reserveAddress }}) above the alert threshold of {{ .Annotations.threshold }} {{ $token }}
{{ if .GeneratorURL -}}[Grafana Alert Link ->]({{ .GeneratorURL }}){{- end }}
{{ end -}}
{{ range .Alerts.Resolved -}}
{{ $token := .Labels.token -}}
{{ $reserveAddress := .Labels.ownerValue -}}
**✅ RESOLVED: Sufficient {{ $token }} balance restored for the [{{ .Labels.owner }}](https://celoscan.io/address/{{ $reserveAddress }}) — {{ .Annotations.currentBalance }}**
{{ end -}}
{{ end -}}

{{ define "discord.trading_mode_alert_title" }}
[{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
{{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
{{ end -}}

{{ define "discord.trading_mode_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $rateFeedWithHyphen := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1-$2" .Labels.rateFeed -}}
{{ $chain := .Labels.chain | title -}}
**🚨 Trading halted for [{{ .Labels.rateFeed }}]({{ .GeneratorURL }}&tab=instances) on {{ $chain }}**{{ if eq $chain "Celo" }}
- Check the [Circuit Breaker Dashboard](https://dune.com/mento-labs-eng/circuit-breakers) for tripped breakers
- Check the [Chainlink feed](https://data.chain.link/feeds/celo/mainnet/{{ $rateFeedWithHyphen }}) for volatility around the alert time{{ end }}
{{ end -}}

{{ range .Alerts.Resolved -}}
{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
{{ $chain := .Labels.chain | title -}}
- **✅ Trading resumed for {{ $rateFeedWithSlash }} on {{ $chain }}**
{{ end -}}

{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing 🙂.{{ end }}
{{ end -}}

{{ define "discord.trading_limits_alert_title" }}
[{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
{{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
{{ end -}}

{{ define "discord.trading_limits_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $chain := .Labels.chain | title -}}
{{ $limitType := .Labels.limitType -}}
**🚨 Trading Limit {{ $limitType }} at {{ with index .Values "utilization" }}{{ . }}{{ else }}unknown{{ end }}% for [{{ .Labels.limitId }}]({{ .GeneratorURL }}&tab=instances) on {{ $chain }}**
- Current utilization: {{ with index .Values "utilization" }}{{ . }}{{ else }}unknown{{ end }}%
- Limit Type: {{ $limitType }}{{ if eq $limitType "L0" }} - short-term (5 minutes){{ else if eq $limitType "L1" }} - medium-term (daily){{ else if eq $limitType "LG" }} - global (has to be manually reset){{ end }}{{ if or (eq $limitType "L1") (eq $limitType "LG") }}
- **Action Required**: This is a {{ if eq $limitType "L1" }}medium-term (daily){{ else }}lifetime{{ end }} limit breach{{ end }}
{{ end -}}

{{ range .Alerts.Resolved -}}
{{ $chain := .Labels.chain | title -}}
{{ $limitType := .Labels.limitType -}}
- **✅ Trading Limit {{ $limitType }} resolved for {{ .Labels.limitId }} on {{ $chain }}**
{{ end -}}

{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing 🙂.{{ end }}
{{ end -}}

{{ define "discord.aegis_service_alert_title" }}
[{{ if (len .Alerts.Firing) }}{{ len .Alerts.Firing }} FIRING{{ end }}{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end }}{{ if (len .Alerts.Resolved) }}{{ len .Alerts.Resolved }} RESOLVED{{ end }}] {{ .CommonLabels.alertname }}
{{ if (len .Alerts.Firing) }}Firing: {{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end }}{{ $alert.Labels.alertname }}{{ end }}{{ end }}
{{ if (len .Alerts.Resolved) }}Resolved: {{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end }}{{ $alert.Labels.alertname }}{{ end }}{{ end }}
{{ end }}

{{ define "discord.aegis_service_alert_message" }}
{{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
{{ range .Alerts.Firing }}
{{ if eq .Labels.alertname "Number of failed rpc calls" }}
**🚨 FIRING: High number of failed RPC calls detected**
- More than 10 errors were detected in a 5-minute timespan
- Check the Aegis service logs for potential issues via `pnpm aegis:logs`
- Verify RPC endpoint connectivity and stability
{{ else if eq .Labels.alertname "Aegis does not report new data" }}
**🚨 FIRING: Aegis service is not reporting new data**
- Aegis has not pushed any new data for more than 5 minutes
- The service may be down or experiencing issues
- Check Aegis service status and logs immediately
{{ else }}
**🚨 FIRING: {{ .Labels.alertname }}**
{{ .Annotations.summary }}
{{ end }}
{{ end }}
{{ range .Alerts.Resolved }}
{{ if eq .Labels.alertname "Number of failed rpc calls" }}
**✅ RESOLVED: RPC call failures have decreased**
- The number of failed RPC calls is now within acceptable limits
{{ else if eq .Labels.alertname "Aegis does not report new data" }}
**✅ RESOLVED: Aegis service is reporting data again**
- Aegis has resumed normal data reporting
{{ else }}
**✅ RESOLVED: {{ .Labels.alertname }}**
{{ end }}
{{ end }}
{{ end }}
EOT
}
