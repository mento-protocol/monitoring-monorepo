# v3 rule groups route through rule-level `notification_settings` instead of
# the global `grafana_notification_policy`. The policy tree in
# notification-policies.tf exists for protocol/Aegis alerts that still rely on
# label-based routing.

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
    title = "{{ if eq .Status \"firing\" }}🚨{{ else }}✅{{ end }}"
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

# Page-grade pool delivery: Splunk On-Call and #alerts-critical from ONE
# contact point.
#
# Every fpmms rule routes through rule-level `notification_settings`, which
# bypasses `grafana_notification_policy.all` entirely. That leaves two ways for
# a pool rule to reach Splunk On-Call:
#
#   1. Drop `notification_settings` from the rule and add a
#      `service=fpmms, severity=page` branch to the policy tree, as the
#      trading-limit and trading-mode pages do. Rejected on two counts. The
#      policy tree's Slack contact points render through
#      `local.alert_config_slack`, an alertname dispatcher with no branch for
#      pool rules — the page would arrive as a raw `.CommonLabels` dump with no
#      pool link. And it would put one rule of the fpmms plane on the
#      label-routed plane, so any later edit that restored rule-level settings
#      (or any new policy branch matching `service=fpmms`) would silently
#      double-deliver the same page through both planes.
#   2. Bundle both destinations in one contact point, as the peg plane already
#      does with `grafana_contact_point.peg_page`. One send per firing group,
#      one delivery per destination, no policy-tree interaction at all.
#
# We take (2). The Slack half reuses the v3 body template so a page looks like
# every other pool alert; the Splunk half gets its own plain-text rendering
# because mrkdwn arrives at the pager as literal asterisks and link syntax.
resource "grafana_contact_point" "pool_page" {
  name = "Pool pages (Splunk On-Call + #alerts-critical)"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_critical
    title     = "{{ if eq .Status \"firing\" }}🚨{{ else }}✅{{ end }}"
    text      = local.slack_body_template
  }

  victorops {
    url         = var.splunk_on_call_alerts_webhook_url
    title       = local.victorops_pool_page_title
    description = local.victorops_pool_page_message
  }
}

resource "grafana_contact_point" "slack_warnings_transition" {
  name = "slack-alerts-warnings-transition"

  slack {
    token                   = var.slack_bot_token
    recipient               = var.slack_channel_warnings
    disable_resolve_message = true
    title                   = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }}"
    text                    = local.slack_body_template
  }
}

# Domain-split warning contact points. v3 warnings route to a domain-
# specific channel based on which service rolls up the rule. Testnet warnings
# route to the existing staging alert channel. The
# `slack_warnings` / `_transition` contact points above are unused once
# every rule has migrated and will be removed in a follow-up cleanup.

resource "grafana_contact_point" "slack_oracles" {
  name = "slack-alerts-oracles"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_oracles
    title     = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }}"
    text      = local.slack_body_template
  }
}

resource "grafana_contact_point" "slack_pools" {
  name = "slack-alerts-pools"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_pools
    title     = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }}"
    text      = local.slack_body_template
  }
}

resource "grafana_contact_point" "slack_pools_transition" {
  name = "slack-alerts-pools-transition"

  slack {
    token                   = var.slack_bot_token
    recipient               = var.slack_channel_pools
    disable_resolve_message = true
    title                   = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }}"
    text                    = local.slack_body_template
  }
}

resource "grafana_contact_point" "slack_infra" {
  name = "slack-alerts-infra"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_infra
    title     = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }}"
    text      = local.slack_body_template
  }
}

resource "grafana_contact_point" "slack_cdps" {
  name = "slack-alerts-cdps"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_cdps
    title     = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }}"
    text      = local.slack_body_template
  }
}

resource "grafana_contact_point" "slack_testnet" {
  name = "slack-alerts-testnet"

  slack {
    token     = var.slack_bot_token
    recipient = var.slack_channel_testnet
    title     = "{{ if eq .Status \"firing\" }}🟡{{ else }}✅{{ end }}"
    text      = local.slack_body_template
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
  #      Rules can override the display title with `title`; resolved messages
  #      can override it with `resolved_title`.
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
  #      Rules may also add a `last_update` row when freshness is the primary
  #      signal.
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
  #      "resolved" post back to the firing post that opened the breach.
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
    {{ if .Annotations.title -}}{{ $title = .Annotations.title }}{{ end -}}
    {{ if and $isResolved .Annotations.resolved_title -}}{{ $title = .Annotations.resolved_title }}{{ end -}}
    {{ if .Labels.pool_id -}}
    *<https://monitoring.mento.org/pool/{{ .Labels.pool_id }}|{{ $title }}{{ if .Labels.pair }} — {{ .Labels.pair }}{{ end }}{{ if .Labels.chain_name }} · {{ .Labels.chain_name | title }}{{ end }}>*
    {{ else if and (eq .Labels.service "cdps") .Labels.symbol -}}
    *<https://monitoring.mento.org/cdps/{{ .Labels.symbol | toLower }}|{{ $title }} — {{ .Labels.symbol }}{{ if .Labels.chain_name }} · {{ .Labels.chain_name | title }}{{ end }}>*
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
    {{ if .Annotations.value_composition -}}
    *Value Share:* {{ .Annotations.value_composition }}
    {{ end -}}
    {{ if .Annotations.breach_duration -}}
    *Breach Duration:* {{ .Annotations.breach_duration }}
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
    {{ if .Annotations.last_update -}}
    *Last Update:* {{ .Annotations.last_update }}
    {{ end -}}
    {{ if .Annotations.breach_started -}}
    *Started:* {{ .Annotations.breach_started }}
    {{ else -}}
    *Started:* {{ .StartsAt.Format "Mon Jan 02 15:04 UTC" }}
    {{ end -}}
    {{ if .Annotations.breach_ended -}}
    *Ended:* {{ .Annotations.breach_ended }}
    {{ else -}}
    {{ if $isResolved -}}
    *Resolved:* {{ .EndsAt.Format "Mon Jan 02 15:04 UTC" }}
    {{ end -}}
    {{ end -}}
    *Alert ID:* `{{ .Fingerprint }}`
    {{ end }}
  EOT

  # Plain-text Splunk On-Call rendering for pool pages. Deliberately not one of
  # the `victorops.*` message templates in message-templates-victorops.tf:
  # those are selected by `local.alert_config_victorops`, an alertname
  # dispatcher belonging to the label-routed plane, and this contact point
  # serves exactly one rule group on the rule-level plane.
  victorops_pool_page_title = <<-EOT
    {{ .CommonLabels.alertname }}{{ if .CommonLabels.pair }} - {{ .CommonLabels.pair }}{{ end }}{{ if .CommonLabels.chain_name }} ({{ .CommonLabels.chain_name }}){{ end }}
  EOT

  victorops_pool_page_message = <<-EOT
    {{ range .Alerts }}{{ if .Annotations.summary }}{{ .Annotations.summary }}
    {{ end }}{{ if .Annotations.current_reserves }}Reserves: {{ .Annotations.current_reserves }}
    {{ end }}{{ if .Annotations.value_composition }}Value share: {{ .Annotations.value_composition }}
    {{ end }}{{ if .Annotations.rebalance_reason }}Rebalance blocked: {{ .Annotations.rebalance_reason }}
    {{ end }}{{ if .Labels.pool_id }}Pool: https://monitoring.mento.org/pool/{{ .Labels.pool_id }}
    {{ end }}Alert ID: {{ .Fingerprint }}
    {{ end }}
  EOT

  # Group/repeat timings applied via notification_settings on every v3 rule.
  # Aegis root policy uses 30s/5m/4h for catch-all. v3 criticals repeat hourly by
  # default so an unacknowledged page doesn't go silent overnight; the one
  # exception is `notify_critical_pool_slow` below, for conditions that stay true
  # for days at a time and where hourly repetition buries the new alerts instead
  # of surfacing the old one.
  #
  # Five variants:
  #   `notify_*_pool` omits `alertname` so co-firing KPI rules on the same
  #     pool (e.g. Pool Depletion Risk + Rebalancer Stale) collapse into one
  #     Slack thread per (chain_id, pool_id). Used by fpmms pool-level rules.
  #   `notify_*` keeps `alertname` (the pre-collapse grouping). Used by
  #     service-scoped rules (metrics-bridge) that lack pool labels —
  #     without alertname they would all merge into one folder-level group.
  #   `notify_critical_pool_slow` is `notify_critical_pool` with a 12h repeat.
  #   `notify_critical_incident` omits `pool_id` so a single upstream failure
  #     that hits many pools at once collapses into one Slack message per
  #     (chain_id, alertname). Used by the oracle-driven criticals.
  #   `notify_page_pool` is `notify_critical_pool` pointed at the bundled
  #     Splunk On-Call + Slack contact point, for the one pool rule that pages.
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

  # Same routing and grouping as `notify_critical_pool`, slower repeat. Split by
  # how long the underlying condition normally lasts, not by severity:
  #   - Oracle and trading-limit criticals describe short-lived incidents that
  #     someone is expected to clear within the hour, so they keep the 1h repeat
  #     above and stay on `notify_critical_pool`.
  #   - Pool-balance criticals (deviation breach, stalled rebalancer) can stay
  #     true for weeks while a fix is planned. CHFm/USDm sat in breach for 14.6
  #     days and re-posted to #alerts-critical up to 24 times a day at the hourly
  #     cadence, which buried every unrelated alert raised in that window.
  # Twice-daily re-notification still surfaces a forgotten breach without
  # crowding out the alerts an operator has not seen yet.
  notify_critical_pool_slow = {
    contact_point   = grafana_contact_point.slack_critical.name
    group_by        = ["grafana_folder", "chain_id", "pool_id"]
    group_wait      = "30s"
    group_interval  = "5m"
    repeat_interval = "12h"
  }

  # Incident-level grouping for criticals whose cause is upstream of any single
  # pool. An oracle stall or a median jump lands on every pool reading that feed
  # at once (observed: 9 pools in 3 minutes, 7 pools in 1 minute), and per-pool
  # grouping turned one incident into that many separate Slack messages.
  # Dropping `pool_id` collapses them into one message; the Slack body ranges
  # over `.Alerts`, so every affected pool still gets its own titled block
  # inside that message. `alertname` is retained so an oracle stall and a price
  # jump on the same chain stay legible as two distinct incidents. The label is
  # `chain_id`, not `chain` — protocol rules carry the former.
  #
  # Repeat stays at the 1h critical default: this variant changes how many
  # messages one incident produces, not how often an unresolved one is repeated,
  # and oracle incidents are expected to clear within the hour.
  notify_critical_incident = {
    contact_point   = grafana_contact_point.slack_critical.name
    group_by        = ["alertname", "grafana_folder", "chain_id"]
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

  # Page-grade pool route. Same per-pool grouping as the critical routes, and
  # the hourly critical repeat rather than the 12h slow one: a pool that is
  # about to stop serving one swap direction is not a "check back tomorrow"
  # condition, and it is rare enough that hourly repetition cannot bury
  # anything.
  notify_page_pool = {
    contact_point   = grafana_contact_point.pool_page.name
    group_by        = ["grafana_folder", "chain_id", "pool_id"]
    group_wait      = "30s"
    group_interval  = "5m"
    repeat_interval = "1h"
  }

  notify_warning_transition = {
    contact_point   = grafana_contact_point.slack_warnings_transition.name
    group_by        = ["alertname", "grafana_folder", "chain_id", "pool_id"]
    group_wait      = "0s"
    group_interval  = "5m"
    repeat_interval = "4h"
  }

  # Each v3 warning rule's `notification_settings` references the
  # notifier matching its service rollup:
  #   - Oracle health (oracle liveness, oracle jump)         → notify_warning_oracles_pool
  #   - Pool mechanics (deviation, rebalancer, trading lim.) → notify_warning_pools_pool
  #   - Pool transitions (deviation breach state changes)    → notify_warning_pools_transition
  #   - Service infrastructure (indexer, metrics-bridge)     → notify_warning_infra
  #   - Testnet service health                               → notify_warning_testnet

  notify_warning_oracles_pool = {
    contact_point   = grafana_contact_point.slack_oracles.name
    group_by        = ["grafana_folder", "chain_id", "pool_id"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }

  notify_warning_pools_pool = {
    contact_point   = grafana_contact_point.slack_pools.name
    group_by        = ["grafana_folder", "chain_id", "pool_id"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }

  notify_warning_pools_transition = {
    contact_point   = grafana_contact_point.slack_pools_transition.name
    group_by        = ["alertname", "grafana_folder", "chain_id", "pool_id"]
    group_wait      = "0s"
    group_interval  = "5m"
    repeat_interval = "4h"
  }

  notify_warning_infra = {
    contact_point   = grafana_contact_point.slack_infra.name
    group_by        = ["alertname", "grafana_folder", "chain_id", "pool_id"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }

  notify_warning_testnet = {
    contact_point = grafana_contact_point.slack_testnet.name
    # Aegis testnet rules carry the `chain` label, not the protocol `chain_id`.
    group_by        = ["alertname", "grafana_folder", "chain"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }

  # CDP (service=cdps) rules group by `collateral_id` — the per-market key the
  # bridge carries on every `mento_cdp_*` series — instead of `pool_id` (CDP
  # markets are not FPMM pools). Criticals page #alerts-critical alongside every
  # other critical; warnings route to the dedicated #alerts-cdps channel.
  # `notify_critical_cdps` omits `alertname` so co-firing per-market criticals
  # (e.g. Shutdown + SP Below Floor) collapse into one Slack thread per market.
  notify_critical_cdps = {
    contact_point   = grafana_contact_point.slack_critical.name
    group_by        = ["grafana_folder", "chain_id", "collateral_id"]
    group_wait      = "30s"
    group_interval  = "5m"
    repeat_interval = "1h"
  }

  notify_warning_cdps = {
    contact_point   = grafana_contact_point.slack_cdps.name
    group_by        = ["grafana_folder", "chain_id", "collateral_id"]
    group_wait      = "1m"
    group_interval  = "10m"
    repeat_interval = "4h"
  }
}
