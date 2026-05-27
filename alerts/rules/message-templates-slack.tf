# Slack mrkdwn message templates per Aegis alertname.
# Selected by the `local.alert_config_slack` dispatcher in locals.tf.

resource "grafana_message_template" "slack_oracle_stale_price_alert_title" {
  name     = "Slack: Stale Price Alert Title"
  template = <<-EOT
{{ define "slack.oracle_stale_price_alert_title" }}{{ if (len .Alerts.Firing) }}🔴{{ else }}✅{{ end }}{{ end }}
EOT
}


resource "grafana_message_template" "slack_oracle_stale_price_alert_message" {
  name = "Slack: Stale Price Alert Message"
  # Per-feed explorer links to relayer signers are set by the chain-specific
  # `${local.celo_relayer_signer_branches}` and
  # `${local.monad_relayer_signer_branches}` fragments (one independent
  # `{{ if eq .Labels.rateFeed "X" }}` block per entry — see locals.tf for
  # the source maps). Each fragment is wrapped in a matching `{{ if eq
  # .Labels.chain ... }}` guard so same-named feeds only render links through
  # that chain's explorer.
  # Cloud function link uses the Logs Explorer URL pattern from
  # `mento-protocol/oracle-relayer:bin/get-function-logs-url.sh` with
  # `resource.labels.service_name=relay-<chain>` AND
  # `labels.rateFeed=<slash-form>` filters and the mainnet project_id from
  # `local.oracle_relayer_mainnet_project_id`. Title link points at the
  # Chainlink data-feed page on Celo (matches the trading_mode template
  # convention; falls back to the Grafana alert details URL on non-Celo
  # chains where Chainlink isn't published).
  #
  # Template only uses Grafana-confirmed primitives: Go text/template
  # builtins (`if`, `eq`, `printf`, assignment) plus `reReplaceAll` (Sprig,
  # already used by the trading-mode and low-balance templates).
  template = <<-EOT
{{ define "slack.oracle_stale_price_alert_message" }}
{{ range .Alerts.Firing -}}
{{ $slash := reReplaceAll "^([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
{{ $hyphen := reReplaceAll "^([A-Z]{3,}?)([A-Z]{3})$" "$1-$2" .Labels.rateFeed -}}
{{ $enc := reReplaceAll "/" "%2F" $slash -}}
{{ $chain := .Labels.chain | title -}}
{{ $relayer := "" -}}
{{ if eq .Labels.chain "celo" -}}
${local.celo_relayer_signer_branches}
{{ end -}}
{{/* monad and monad-testnet currently share signer addresses; split maps if testnet diverges. */ -}}
{{ if or (eq .Labels.chain "monad") (eq .Labels.chain "monad-testnet") -}}
${local.monad_relayer_signer_branches}
{{ end -}}
{{ $titleURL := .GeneratorURL -}}
{{ if eq .Labels.chain "celo" -}}{{ $titleURL = printf "https://data.chain.link/feeds/celo/mainnet/%s" $hyphen -}}{{ end -}}
*<{{ $titleURL }}|Stale price for the {{ $slash }} rate feed on {{ $chain }}>*
- Check the latest transactions of the {{ if $relayer -}}<https://{{ .Labels.explorer }}/address/{{ $relayer }}|{{ $slash }} relayer on {{ $chain }}>{{- else -}}{{ $slash }} relayer on {{ $chain }}{{- end }}
- Check if the <https://console.cloud.google.com/logs/query;query=resource.labels.service_name%3D%22relay-{{ .Labels.chain }}%22%20AND%20labels.rateFeed%3D%22{{ $enc }}%22?project=${local.oracle_relayer_mainnet_project_id}|relayer cloud function> is still being triggered regularly

{{ end -}}
{{ range .Alerts.Resolved -}}
{{ $slash := reReplaceAll "^([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
{{ $hyphen := reReplaceAll "^([A-Z]{3,}?)([A-Z]{3})$" "$1-$2" .Labels.rateFeed -}}
{{ $chain := .Labels.chain | title -}}
{{ $titleURL := .GeneratorURL -}}
{{ if eq .Labels.chain "celo" -}}{{ $titleURL = printf "https://data.chain.link/feeds/celo/mainnet/%s" $hyphen -}}{{ end -}}
*<{{ $titleURL }}|{{ $slash }} price is fresh again on {{ $chain }}>*
{{ end -}}
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
  {{ define "slack.trading_mode_alert_title" }}{{ if (len .Alerts.Firing) }}🚨{{ else }}✅{{ end }}{{ end -}}
  EOT
}

resource "grafana_message_template" "slack_trading_mode_alert_message" {
  name = "Slack: Trading Mode Alert Message"
  # Pool URL: `$pool` is set per-chain by the `celo_pool_branches` / `monad_pool_branches`
  # fragments (one independent `{{ if eq .Labels.rateFeed "X" -}}` block per entry, see
  # locals.tf). When set, we build `monitoring.mento.org/pool/<chain_id>-<pool>?tab=oracle`;
  # otherwise we fall back to the Grafana alert-details URL so the bullet still resolves.
  # Chainlink URL: gated on both `$chainlinkFeedPath` (chain-level — empty for testnets)
  # AND `$chainlinkSlug` (per-rateFeed allowlist — only set for feeds Chainlink actually
  # publishes; cross-rates like CELOAUD are absent and the line is dropped instead of
  # linking to a 404). The path is a full two-segment slug because Chainlink's URLs
  # aren't uniform: Celo uses `celo/mainnet`, Monad uses `monad/monad`. Source of truth
  # for the chain path: `ui-dashboard/src/lib/tokens.ts` CHAINLINK_FEEDS. Source of truth
  # for the per-feed allowlist: `reference-data-directory.vercel.app/feeds-<chain>-mainnet.json`.
  template = <<-EOT
{{ define "slack.trading_mode_alert_message" }}
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
*Trading halted for {{ $rateFeedWithSlash }} on {{ $chain }}*
- Check for tripped breakers on the <{{ $poolURL }}|{{ if $pool }}{{ $rateFeedWithSlash }} pool{{ else }}alert details{{ end }}>{{ if and $chainlinkFeedPath $chainlinkSlug }}
- Check the <https://data.chain.link/feeds/{{ $chainlinkFeedPath }}/{{ $chainlinkSlug }}|Chainlink feed> for volatility around the alert time at {{ .StartsAt.Format "Mon Jan 02 15:04 UTC" }}{{ end }}
{{ end -}}

{{ range .Alerts.Resolved -}}
{{ $rateFeedWithSlash := reReplaceAll "([A-Z]{3,}?)([A-Z]{3})$" "$1/$2" .Labels.rateFeed -}}
{{ $chain := .Labels.chain | title -}}
*Trading resumed for {{ $rateFeedWithSlash }} on {{ $chain }}*
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
