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
    # Minimal title: Grafana hardcodes attachment.title_link to the alert detail
    # URL on grafana.com, and the terraform provider does not expose title_link
    # as a configurable field. Demoting the title to a single status emoji
    # keeps Slack's push/preview text small and unobtrusive; the prominent
    # human-readable title is rendered as the first line of the body, where
    # mrkdwn links are honoured (see local.slack_body_template).
    title = "{{ if eq .Status \"firing\" }}🔴{{ else }}✅{{ end }}"
    text  = local.slack_body_template
  }
}

resource "grafana_contact_point" "slack_warnings" {
  name = "slack-alerts-warnings"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_warnings
    # See note on slack_critical above — same title-link constraint applies.
    title = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }}"
    text  = local.slack_body_template
  }
}

locals {
  # Shared message body — both contact points (critical + warnings) render the
  # same structure so operators can't mistake fields between channels. Split
  # into `slack_body_critical` / `slack_body_warning` the first time the two
  # layouts need to diverge (e.g. if critical grows an "ack" action row).
  #
  # Layout (pool-scoped, e.g. fpmms rules):
  #   1. Bold linked title: `*<pool details URL|alertname — pair · chain>*`.
  #      Acts as the prominent visual title because Grafana's attachment.title
  #      links to grafana.com and that link target is not configurable from
  #      the terraform provider.
  #   2. One-line headline from the rule's `summary` annotation.
  #   3. Italicised `description` with likely causes — CRITICAL-severity rules
  #      only. Warnings are summary-only: authors can still set a `description`
  #      annotation (useful in the Grafana rule-detail view) but it is
  #      intentionally suppressed in Slack to keep warning messages at a
  #      glance-able 4 lines.
  #   4. Optional KPI lines from rule-specific annotations (rebalance_reason,
  #      current_reserves, current_oracle_price, previous_oracle_price, …).
  #      Each guarded by `{{ if .Annotations.X }}`
  #      so rules that don't set the annotation render nothing — no empty
  #      "*Foo:*" placeholder. Add new lines here when introducing rule-
  #      specific context fields; rules that don't set them are unaffected.
  #
  #      The *Rebalance Blocked* row is sourced from the metrics-bridge
  #      `mento_pool_rebalance_blocked` gauge, so the operator sees the
  #      bounded Solidity-error explanation inline with the breach while the
  #      decoded custom-error code remains on the gauge for diagnostics.
  #      For Celo USDC/USDT/axlUSDC pools the row also appends the
  #      Reserve's live ERC20 balance from Aegis ("Reserve Balance:
  #      0.05 USDT") so operators can see at a glance how short the
  #      reserve is. Suppressed cleanly when the probe hasn't run yet or
  #      the RPC failed — the breach alert keeps its normal shape.
  #
  #      Deviation-breach alerts deliberately render in operator triage order:
  #      message, reserves, rebalance-blocked reason, then start time.
  #      Rebalancer alerts may add Last Rebalance / Root Cause rows when the
  #      rule exposes those annotations.
  #   5. Metadata row: start time plus resolved time when applicable. The
  #      per-row `View alert` link was removed — Grafana's attachment title
  #      still links to grafana.com via the (unconfigurable) `title_link`, so
  #      operators retain that path without per-row chrome. `notify_*_pool`
  #      collapses multiple alertnames per (chain_id, pool_id), but the linked
  #      title (point 1) already names the firing alert.
  #
  #      The timestamp uses Go format `"Jan 02 15:04 UTC"` so multi-day-old
  #      breaches read e.g. "Apr 28 15:04 UTC" instead of just "15:04 UTC"
  #      — the latter is misleading once a breach lives longer than a day.
  #   6. *Alert ID* — Grafana's `.Fingerprint`, a deterministic hash of the
  #      alert's label set. The same value is rendered on the firing and the
  #      resolved message, so an operator scrolling Slack can match a ✅
  #      "resolved" post back to the 🔴 "fired" post that opened the breach.
  #      Especially useful for deviation breaches where the same pool can
  #      churn through multiple fire/resolve cycles in a day.
  #
  # Layout (service-scoped, e.g. metrics-bridge — no pool_id/pair/chain):
  #   1. Plain bold alertname (no link target — there is no pool details page).
  #   2. Summary / description as above.
  #   3. Metadata row with start time and Alert ID, as in the pool-scoped layout.
  slack_body_template = <<-EOT
    {{ range .Alerts -}}
    {{ $isResolved := eq .Status "resolved" -}}
    {{ $title := .Labels.alertname -}}
    {{ if and $isResolved .Annotations.resolved_title -}}{{ $title = .Annotations.resolved_title }}{{ end -}}
    {{ if .Labels.pool_id -}}
    *<https://monitoring.mento.org/pool/{{ .Labels.pool_id }}|{{ $title }}{{ if .Labels.pair }} — {{ .Labels.pair }}{{ end }}{{ if .Labels.chain_name }} · {{ .Labels.chain_name | title }}{{ end }}>*
    {{ else -}}
    *{{ $title }}*
    {{ end -}}
    {{ if and $isResolved .Annotations.resolved_summary }}{{ .Annotations.resolved_summary }}
    {{ else if .Annotations.summary }}{{ .Annotations.summary }}
    {{ end -}}
    {{ if and .Annotations.description (eq .Labels.severity "critical") -}}
    _{{ .Annotations.description }}_
    {{ end -}}
    {{ if .Annotations.current_reserves -}}
    *Reserves:* {{ .Annotations.current_reserves }}
    {{ end -}}
    {{ if .Annotations.rebalance_reason -}}
    *Rebalance Blocked:* {{ .Annotations.rebalance_reason }}
    {{ end -}}
    {{ if .Annotations.last_rebalance -}}
    *Last Rebalance:* {{ .Annotations.last_rebalance }}
    {{ end -}}
    {{ if .Annotations.root_cause -}}
    *Root Cause:* {{ .Annotations.root_cause }}
    {{ end -}}
    {{ if .Annotations.current_oracle_price -}}
    *Current Oracle Price:* {{ .Annotations.current_oracle_price }}
    {{ end -}}
    {{ if .Annotations.previous_oracle_price -}}
    *Previous Oracle Price:* {{ .Annotations.previous_oracle_price }}
    {{ end -}}
    *Started:* {{ .StartsAt.Format "Mon Jan 02 15:04 UTC" }}
    {{ if $isResolved -}}
    *Resolved:* {{ .EndsAt.Format "Mon Jan 02 15:04 UTC" }}
    {{ end -}}
    *Alert ID:* `{{ .Fingerprint }}`
    {{ end }}
  EOT

  # Group/repeat timings applied via notification_settings on every v3 rule.
  # Aegis root policy uses 30s/5m/4h for catch-all; v3 shortens repeat to 1h so
  # unacknowledged pages don't go silent overnight.
  #
  # Two variants:
  #   `notify_*_pool` omits `alertname` so co-firing KPI rules on the same
  #     pool (e.g. Deviation Breach + Rebalancer Stale) collapse into one
  #     Slack thread per (chain_id, pool_id). Used by fpmms pool-level rules.
  #   `notify_*` keeps `alertname` (the pre-collapse grouping). Used by
  #     service-scoped rules (metrics-bridge) that lack pool labels —
  #     without alertname they would all merge into one folder-level group.
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

  notify_critical_pool = {
    contact_point   = grafana_contact_point.slack_critical.name
    group_by        = ["grafana_folder", "chain_id", "pool_id"]
    group_wait      = "30s"
    group_interval  = "5m"
    repeat_interval = "1h"
  }

  notify_warning_pool = {
    contact_point   = grafana_contact_point.slack_warnings.name
    group_by        = ["grafana_folder", "chain_id", "pool_id"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }
}
