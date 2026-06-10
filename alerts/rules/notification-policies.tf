resource "grafana_notification_policy" "all" {
  group_by      = ["alertname", "chain"]
  contact_point = grafana_contact_point.slack_alerts_infra.name # Default contact point

  policy {
    group_wait      = "30s"
    group_interval  = "5m"
    repeat_interval = "4h"

    # On-Call Alert Policy for weekend-enabled feeds
    policy {
      contact_point = grafana_contact_point.splunk_on_call.name

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      # Only weekend-enabled feeds (by excluding weekend-disabled feeds)
      matcher {
        label = "rateFeed"
        match = "!~"
        value = local.weekend_disabled_feeds_pattern
      }

      continue = true
    }

    # On-Call Alert Policy for weekend-disabled feeds
    policy {
      contact_point = grafana_contact_point.splunk_on_call.name

      # Apply the mute timing to the policy
      mute_timings = [grafana_mute_timing.weekend_mute.name]

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      # Only weekend-disabled feeds
      matcher {
        label = "rateFeed"
        match = "=~"
        value = local.weekend_disabled_feeds_pattern
      }

      continue = true
    }

    # Aegis Service Alerts - Splunk On-Call
    policy {
      contact_point = grafana_contact_point.splunk_on_call.name

      matcher {
        label = "service"
        match = "="
        value = "aegis"
      }

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      continue = true
    }

    # Trading Limits Alerts - Splunk On-Call (L1 and LG only)
    policy {
      contact_point = grafana_contact_point.splunk_on_call.name

      matcher {
        label = "service"
        match = "="
        value = "trading-limits"
      }

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      continue = true
    }

    # Slack policies are the terminal delivery routes. Severity matchers split
    # alerts between `#alerts-critical` and the per-service warning channel.
    # Oracle-relayer policies preserve the `weekend_mute` timing on FX feeds —
    # see `weekend_disabled_feeds` in locals.tf.

    # Oracle Relayer page alerts → #alerts-critical (non-weekend FX)
    # `severity = page` already restricts to prod chains because
    # `alert-rules-oracle-relayers.tf:22` only stamps severity=page when
    # `rule.value.env == "prod"`. No need for a chain-specific matcher —
    # this previously hardcoded `chain = "celo"` which silently dropped
    # Monad (env=prod) page alerts from #alerts-critical (sec-review
    # 2026-05-22 f-010).
    # `continue = true` so pages also reach the #alerts-oracles copies below —
    # the oracle-domain channel carries the full oracle picture, pages included.
    policy {
      contact_point = grafana_contact_point.slack_alerts_critical.name

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "rateFeed"
        match = "!~"
        value = local.weekend_disabled_feeds_pattern
      }

      continue = true
    }

    # Oracle Relayer page alerts → #alerts-critical (weekend FX, muted)
    # Same severity=page gating as the non-weekend policy above.
    policy {
      contact_point = grafana_contact_point.slack_alerts_critical.name
      mute_timings  = [grafana_mute_timing.weekend_mute.name]

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "rateFeed"
        match = "=~"
        value = local.weekend_disabled_feeds_pattern
      }

      continue = true
    }

    # Oracle Relayer page alerts → #alerts-oracles (non-weekend FX).
    # Terminal copy of the #alerts-critical pair above (which `continue`s),
    # in addition to Splunk On-Call — so page-grade oracle incidents are
    # visible in the oracle-domain channel alongside the warning-grade ones.
    policy {
      contact_point = grafana_contact_point.slack_alerts_oracles.name

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "rateFeed"
        match = "!~"
        value = local.weekend_disabled_feeds_pattern
      }

    }

    # Oracle Relayer page alerts → #alerts-oracles (weekend FX, muted)
    policy {
      contact_point = grafana_contact_point.slack_alerts_oracles.name
      mute_timings  = [grafana_mute_timing.weekend_mute.name]

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "rateFeed"
        match = "=~"
        value = local.weekend_disabled_feeds_pattern
      }

    }

    # Oracle Relayer warning alerts → #alerts-oracles (prod chains, non-weekend FX)
    dynamic "policy" {
      for_each = local.prod_chains
      content {
        contact_point = grafana_contact_point.slack_alerts_oracles.name

        matcher {
          label = "service"
          match = "="
          value = "oracle-relayers"
        }

        matcher {
          label = "chain"
          match = "="
          value = policy.key
        }

        matcher {
          label = "severity"
          match = "!="
          value = "page"
        }

        matcher {
          label = "rateFeed"
          match = "!~"
          value = local.weekend_disabled_feeds_pattern
        }

      }
    }

    # Oracle Relayer warning alerts → #alerts-oracles (prod chains, weekend FX, muted).
    # The rateFeed matcher selects weekend-disabled feeds; chains without them match nothing.
    dynamic "policy" {
      for_each = local.prod_chains
      content {
        contact_point = grafana_contact_point.slack_alerts_oracles.name
        mute_timings  = [grafana_mute_timing.weekend_mute.name]

        matcher {
          label = "service"
          match = "="
          value = "oracle-relayers"
        }

        matcher {
          label = "chain"
          match = "="
          value = policy.key
        }

        matcher {
          label = "severity"
          match = "!="
          value = "page"
        }

        matcher {
          label = "rateFeed"
          match = "=~"
          value = local.weekend_disabled_feeds_pattern
        }

      }
    }

    # Oracle Relayer alerts → #alerts-testnet (staging chains, non-weekend FX, any severity)
    dynamic "policy" {
      for_each = local.staging_chains
      content {
        contact_point = grafana_contact_point.slack_alerts_testnet.name

        matcher {
          label = "service"
          match = "="
          value = "oracle-relayers"
        }

        matcher {
          label = "chain"
          match = "="
          value = policy.key
        }

        matcher {
          label = "rateFeed"
          match = "!~"
          value = local.weekend_disabled_feeds_pattern
        }

      }
    }

    # Oracle Relayer alerts → #alerts-testnet (staging chains, weekend FX, muted).
    # The rateFeed matcher selects weekend-disabled feeds; chains without them match nothing.
    dynamic "policy" {
      for_each = local.staging_chains
      content {
        contact_point = grafana_contact_point.slack_alerts_testnet.name
        mute_timings  = [grafana_mute_timing.weekend_mute.name]

        matcher {
          label = "service"
          match = "="
          value = "oracle-relayers"
        }

        matcher {
          label = "chain"
          match = "="
          value = policy.key
        }

        matcher {
          label = "rateFeed"
          match = "=~"
          value = local.weekend_disabled_feeds_pattern
        }

      }
    }

    # Reserve alerts → #alerts-reserve
    policy {
      contact_point = grafana_contact_point.slack_alerts_reserve.name

      matcher {
        label = "service"
        match = "="
        value = "reserve"
      }

    }

    # Trading-modes prod page alerts → Splunk On-Call (one per prod chain).
    # A prod circuit-breaker engagement is pager-grade — see the
    # severity=page label in alert-rules-trading-modes.tf.
    dynamic "policy" {
      for_each = local.prod_chains
      content {
        contact_point = grafana_contact_point.splunk_on_call.name

        matcher {
          label = "severity"
          match = "="
          value = "page"
        }

        matcher {
          label = "service"
          match = "="
          value = "exchanges"
        }

        matcher {
          label = "chain"
          match = "="
          value = policy.key
        }

        continue = true
      }
    }

    # Trading-modes prod page alerts → #alerts-critical (one per prod chain)
    dynamic "policy" {
      for_each = local.prod_chains
      content {
        contact_point = grafana_contact_point.slack_alerts_critical.name

        matcher {
          label = "severity"
          match = "="
          value = "page"
        }

        matcher {
          label = "service"
          match = "="
          value = "exchanges"
        }

        matcher {
          label = "chain"
          match = "="
          value = policy.key
        }

      }
    }

    # Trading-modes alerts → #alerts-testnet (staging chains, any severity)
    dynamic "policy" {
      for_each = local.staging_chains
      content {
        contact_point = grafana_contact_point.slack_alerts_testnet.name

        matcher {
          label = "service"
          match = "="
          value = "exchanges"
        }

        matcher {
          label = "chain"
          match = "="
          value = policy.key
        }

      }
    }

    # Aegis service page alerts → #alerts-critical (parallel to existing Splunk policy)
    policy {
      contact_point = grafana_contact_point.slack_alerts_critical.name

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      matcher {
        label = "service"
        match = "="
        value = "aegis"
      }

    }

    # Aegis service warning alerts → #alerts-infra
    policy {
      contact_point = grafana_contact_point.slack_alerts_infra.name

      matcher {
        label = "service"
        match = "="
        value = "aegis"
      }

      matcher {
        label = "severity"
        match = "!="
        value = "page"
      }

    }

    # Trading-limits page alerts → #alerts-critical (parallel to existing Splunk policy)
    policy {
      contact_point = grafana_contact_point.slack_alerts_critical.name

      matcher {
        label = "severity"
        match = "="
        value = "page"
      }

      matcher {
        label = "service"
        match = "="
        value = "trading-limits"
      }

    }

    # Trading-limits warning alerts → #alerts-pools
    policy {
      contact_point = grafana_contact_point.slack_alerts_pools.name

      matcher {
        label = "service"
        match = "="
        value = "trading-limits"
      }

      matcher {
        label = "severity"
        match = "!="
        value = "page"
      }

    }
  }
}
