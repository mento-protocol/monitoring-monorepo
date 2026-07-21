# Plain-text message templates per Aegis alertname for Splunk On-Call.
# VictorOps renders raw text — no markdown survives. Selected by the
# `local.alert_config_victorops` dispatcher in locals.tf.

resource "grafana_message_template" "victorops_oracle_stale_price_alert_title" {
  name     = "VictorOps - Stale Price Alert Title"
  template = <<-EOT
{{ define "victorops.oracle_stale_price_alert_title" }}
{{ if (len .Alerts.Firing) -}}
P1 {{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end -}}{{ $slash := reReplaceAll "^([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" $alert.Labels.rateFeed -}}{{ $alert.Labels.chain | title }} {{ $slash }} oracle report expired{{ end -}}
{{ end -}}
{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end -}}
{{ if (len .Alerts.Resolved) -}}
RESOLVED {{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end -}}{{ $slash := reReplaceAll "^([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" $alert.Labels.rateFeed -}}{{ $alert.Labels.chain | title }} {{ $slash }} oracle report fresh{{ end -}}
{{ end -}}
{{ if and (eq (len .Alerts.Firing) 0) (eq (len .Alerts.Resolved) 0) -}}
Oracle report status unknown
{{ end -}}
{{ end }}
EOT
}


resource "grafana_message_template" "victorops_oracle_stale_price_alert_message" {
  name     = "VictorOps - Stale Price Alert Message"
  template = <<-EOT
{{ define "victorops.oracle_stale_price_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $slash := reReplaceAll "^([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
{{ $enc := reReplaceAll "/" "%2F" $slash -}}
{{ if and (or (eq .Labels.chain "polygon") (eq .Labels.chain "polygon-testnet")) (eq .Labels.rateFeed "EUROPEUR") -}}
PROBLEM: The fixed 1.0 EUR-parity report in SortedOracles on {{ .Labels.chain | title }} has expired. Swaps using this feed may revert until the fixed report is refreshed.
ACTION: Inspect the fixed report, then contact the deployment/migration owner responsible for it.
{{ else -}}
PROBLEM: The {{ $slash }} on-chain oracle report on {{ .Labels.chain | title }} has expired. Swaps using this feed may revert until a fresh report is relayed.
ACTION: Check whether relay-{{ .Labels.chain }} is executing and inspect the {{ $slash }} relayer errors. If this is an FX feed during the weekend market closure, the alert routing is misconfigured; snooze it and escalate the monitoring configuration.
Logs: https://console.cloud.google.com/logs/query;query=resource.labels.service_name%3D%22relay-{{ .Labels.chain }}%22%20AND%20labels.rateFeed%3D%22{{ $enc }}%22?project=${local.oracle_relayer_mainnet_project_id}
{{ end -}}
Alert: {{ .GeneratorURL }}
Started: {{ .StartsAt.Format "Mon Jan 02 15:04 UTC" }}
{{ end -}}
{{ range .Alerts.Resolved -}}
{{ $slash := reReplaceAll "^([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
RESOLVED: The {{ $slash }} oracle report on {{ .Labels.chain | title }} is fresh again.
Resolved: {{ .EndsAt.Format "Mon Jan 02 15:04 UTC" }}
{{ end -}}
{{ end }}
EOT
}

resource "grafana_message_template" "victorops_oracle_relayer_low_balance_alert_title" {
  name     = "VictorOps - Low Relayer Balance Alert Title"
  template = <<-EOT
{{ define "victorops.oracle_relayer_low_balance_alert_title" }}Low Relayer Balance{{ end }}
EOT
}


resource "grafana_message_template" "victorops_oracle_relayer_low_balance_alert_message" {
  name     = "VictorOps - Low Relayer Balance Alert Message"
  template = <<-EOT
{{ define "victorops.oracle_relayer_low_balance_alert_message" }}
{{ range .Alerts.Firing }}
{{ $pair := reReplaceAll "^RelayerSigner([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.owner }}
Low {{ .Labels.token }} balance for {{ $pair }} Relayer on {{ .Labels.chain | title }} — {{ .Annotations.currentBalance }} {{ .Labels.token }} left
Wallet: https://{{ .Labels.explorer }}/address/{{ .Labels.ownerValue }}
- Top up the relayer wallet to keep the relayer running
- Run the relayer refill script (https://github.com/mento-protocol/oracle-relayer?tab=readme-ov-file#refilling-relayer-signer-accounts), or top up from the dev wallet until the balance is at least {{ .Annotations.threshold }} {{ .Labels.token }}
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
  name     = "VictorOps - Reserve Balance Alert Title"
  template = <<-EOT
  {{ define "victorops.reserve_balance_alert_title" }}
  [{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
  {{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
  {{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
  {{ end -}}
  EOT
}

resource "grafana_message_template" "victorops_reserve_balance_alert_message" {
  name     = "VictorOps - Reserve Balance Alert Message"
  template = <<-EOT
  {{ define "victorops.reserve_balance_alert_message" }}
  {{ if eq (len .Alerts.Firing) 0 }}No alerts are currently firing.{{ end }}
  {{ range .Alerts.Firing -}}
  {{ $token := .Labels.token -}}
  {{ $reserveAddress := .Labels.ownerValue -}}
FIRING: Low {{ $token }} balance — {{ .Annotations.currentBalance }} left
Please top up the {{ $token }} balance of the {{ .Labels.owner }} ({{ $reserveAddress }}) above the alert threshold of {{ .Annotations.threshold }} {{ $token }}. Address: https://{{ .Labels.explorer }}/address/{{ $reserveAddress }}
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
  name     = "VictorOps - Trading Mode Alert Title"
  template = <<-EOT
{{ define "victorops.trading_mode_alert_title" -}}
{{ if (len .Alerts.Firing) -}}
{{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end -}}{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}{{ $chain := .Labels.chain | title -}}{{ $rateFeedWithSlash }} [{{ $chain }}]{{ end -}}
{{ else if (len .Alerts.Resolved) -}}
{{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end -}}{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}{{ $chain := .Labels.chain | title -}}{{ $rateFeedWithSlash }} [{{ $chain }}]{{ end -}}
{{ else -}}
Trading mode alert
{{ end -}}
{{ end -}}
  EOT
}

resource "grafana_message_template" "victorops_trading_mode_alert_message" {
  name     = "VictorOps - Trading Mode Alert Message"
  template = <<-EOT
{{ define "victorops.trading_mode_alert_message" }}
{{ $firingCount := len .Alerts.Firing -}}
{{ $resolvedCount := len .Alerts.Resolved -}}
{{ $mixedState := and $firingCount $resolvedCount -}}
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
{{ if eq .Labels.chain "polygon" -}}
${local.polygon_pool_branches}
${local.polygon_chainlink_slug_branches}
{{ end -}}
{{ $poolURL := printf "%s&tab=instances" .GeneratorURL -}}
{{ if and $chainId $pool -}}{{ $poolURL = printf "https://monitoring.mento.org/pool/%s-%s?tab=oracle" $chainId $pool }}{{ end -}}
{{ $chainlinkURL := "" -}}
{{ if and $chainlinkFeedPath $chainlinkSlug -}}{{ $chainlinkURL = printf "https://data.chain.link/feeds/%s/%s" $chainlinkFeedPath $chainlinkSlug }}{{ end -}}
{{ if or $mixedState (gt $firingCount 1) -}}
{{ $rateFeedWithSlash }} [{{ $chain }}]: Trading halted by breaker
{{ else -}}
Trading halted by breaker.
{{ end -}}
{{ if $chainlinkURL -}}
Next action: verify the Chainlink data source, then ack/snooze if the move is real. Do not manually reset unless the feed is wrong or the breaker is stuck after recovery.
- Chainlink data source: {{ $chainlinkURL }}
{{ else -}}
Next action: open breaker status and confirm the underlying rate-feed or market move, then ack/snooze if the halt is expected. Do not manually reset unless the feed is wrong or the breaker is stuck after recovery.
{{ end -}}
- Breaker status: {{ $poolURL }}
Alert time: {{ .StartsAt.Format "Mon Jan 02 15:04 UTC" }}
{{ end -}}

{{ range .Alerts.Resolved -}}
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
{{ if eq .Labels.chain "polygon" -}}
${local.polygon_pool_branches}
${local.polygon_chainlink_slug_branches}
{{ end -}}
{{ $poolURL := printf "%s&tab=instances" .GeneratorURL -}}
{{ if and $chainId $pool -}}{{ $poolURL = printf "https://monitoring.mento.org/pool/%s-%s?tab=oracle" $chainId $pool }}{{ end -}}
{{ $chainlinkURL := "" -}}
{{ if and $chainlinkFeedPath $chainlinkSlug -}}{{ $chainlinkURL = printf "https://data.chain.link/feeds/%s/%s" $chainlinkFeedPath $chainlinkSlug }}{{ end -}}
{{ if or $mixedState (gt $resolvedCount 1) -}}
{{ $rateFeedWithSlash }} [{{ $chain }}]: Trading resumed
{{ else -}}
Trading resumed.
{{ end -}}
{{ if $chainlinkURL -}}
- Chainlink data source: {{ $chainlinkURL }}
{{ end -}}
- Breaker status: {{ $poolURL }}
Resolved at: {{ .EndsAt.Format "Mon Jan 02 15:04 UTC" }}
{{ end -}}

{{ if eq $firingCount 0 }}No alerts are currently firing.{{ end }}
{{ end -}}
EOT
}

resource "grafana_message_template" "victorops_trading_limits_alert_title" {
  name     = "VictorOps - Trading Limits Alert Title"
  template = <<-EOT
  {{ define "victorops.trading_limits_alert_title" }}
  [{{ if (len .Alerts.Firing) -}}{{ len .Alerts.Firing }} FIRING{{ end -}}
  {{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}} | {{ end -}}
  {{ if (len .Alerts.Resolved) -}}{{ len .Alerts.Resolved }} RESOLVED{{ end -}}] {{ .CommonLabels.alertname -}}
  {{ end -}}
  EOT
}

resource "grafana_message_template" "victorops_trading_limits_alert_message" {
  name     = "VictorOps - Trading Limits Alert Message"
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
  name     = "VictorOps - Aegis Service Alert Title"
  template = <<-EOT
{{ define "victorops.aegis_service_alert_title" -}}
{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) -}}
{{ .CommonLabels.alertname -}}
{{ else if (len .Alerts.Firing) -}}
{{ range $i, $alert := .Alerts.Firing -}}{{ if $i }}, {{ end -}}{{ if eq $alert.Labels.alertname "Aegis view-call failures [production]" -}}{{ $chain := $alert.Labels.chain | title -}}{{ $chain }}: Aegis view calls failing for {{ $alert.Labels.contract }}.{{ $alert.Labels.functionName }}{{ else if eq $alert.Labels.alertname "Aegis does not report new data" -}}Aegis has stopped reporting data{{ else -}}{{ $alert.Labels.alertname }}{{ end -}}{{ end -}}
{{ else if (len .Alerts.Resolved) -}}
{{ range $i, $alert := .Alerts.Resolved -}}{{ if $i }}, {{ end -}}{{ if eq $alert.Labels.alertname "Aegis view-call failures [production]" -}}{{ $chain := $alert.Labels.chain | title -}}{{ $chain }}: Aegis view calls recovered for {{ $alert.Labels.contract }}.{{ $alert.Labels.functionName }}{{ else if eq $alert.Labels.alertname "Aegis does not report new data" -}}Aegis data reporting recovered{{ else -}}{{ $alert.Labels.alertname }} resolved{{ end -}}{{ end -}}
{{ end -}}
{{ end -}}
EOT
}

resource "grafana_message_template" "victorops_aegis_service_alert_message" {
  name     = "VictorOps - Aegis Service Alert Message"
  template = <<-EOT
{{ define "victorops.aegis_service_alert_message" }}
{{ $firingCount := len .Alerts.Firing -}}
{{ $mixedState := and (len .Alerts.Firing) (len .Alerts.Resolved) -}}
{{ range .Alerts.Firing -}}
{{ if eq .Labels.alertname "Aegis view-call failures [production]" }}
{{ $chain := .Labels.chain | title -}}
{{ if $mixedState }}{{ $chain }}: Aegis view calls failing for {{ .Labels.contract }}.{{ .Labels.functionName }}
{{ end -}}
Why this matters: Aegis cannot reliably read {{ .Labels.contract }}.{{ .Labels.functionName }} on {{ $chain }}. These reads feed protocol monitoring metrics; if failures continue, downstream oracle, breaker, reserve, or trading-limit alerts can be delayed or suppressed.
Next action: open Aegis logs, filter for chain={{ .Labels.chain }} and call={{ .Labels.contract }}.{{ .Labels.functionName }}, and decide whether this is an RPC endpoint outage or a deterministic contract/config failure.
- If RPC-only: check the configured primary/fallback endpoint health and provider status.
- If deterministic: fix or revert the metric config; retrying a fallback endpoint will not help.
- Failed samples in the current 5m window: {{ with index .Values "errorCount" }}{{ reReplaceAll "\\.[0-9]+$" "" (printf "%v" .) }}{{ else }}unknown{{ end }}
- Alert details: {{ .GeneratorURL }}&tab=instances
- Logs: pnpm aegis:logs
{{ else if eq .Labels.alertname "Aegis does not report new data" }}
{{ if $mixedState }}Aegis has stopped reporting data
{{ end -}}
Why this matters: Aegis has not pushed any new metrics for more than 5 minutes, so protocol alert inputs may be stale.
Next action: check App Engine service health and Aegis logs immediately.
- Alert details: {{ .GeneratorURL }}&tab=instances
- Logs: pnpm aegis:logs
{{ else }}
FIRING: {{ .Labels.alertname }}
{{ .Annotations.summary }}
{{ end }}
{{ end }}
{{ range .Alerts.Resolved -}}
{{ if eq .Labels.alertname "Aegis view-call failures [production]" }}
{{ $chain := .Labels.chain | title -}}
Aegis view calls recovered for {{ .Labels.contract }}.{{ .Labels.functionName }} on {{ $chain }}.
- The per-call error rate is back below 10 failed samples per 5 minutes.
{{ else if eq .Labels.alertname "Aegis does not report new data" }}
Aegis data reporting recovered.
- Aegis has resumed normal data reporting.
{{ else }}
RESOLVED: {{ .Labels.alertname }}
{{ end }}
{{ end }}
{{ if eq $firingCount 0 }}No alerts are currently firing.{{ end }}
{{ end }}
EOT
}
