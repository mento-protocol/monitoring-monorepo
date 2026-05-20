resource "grafana_notification_policy" "all" {
  group_by      = ["alertname", "chain"]
  contact_point = grafana_contact_point.discord_channel_catch_all.name # Default contact point

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

    # Oracle Relayer Alerts [Celo-Sepolia]
    policy {
      contact_point = grafana_contact_point.discord_channel_oracle_relayers_staging.name

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo-sepolia"
      }

      # Exclude the weekend-disabled feeds
      matcher {
        label = "rateFeed"
        match = "!~"
        value = local.weekend_disabled_feeds_pattern
      }

      continue = true
    }

    # Mute notifications on weekends for FX feeds that don't receive new data on weekends [Sepolia]
    policy {
      # Apply the mute timing to the policy
      mute_timings = [grafana_mute_timing.weekend_mute.name]

      # Use the same contact point as the Sepolia Oracle Relayer policy
      contact_point = grafana_contact_point.discord_channel_oracle_relayers_staging.name

      # Only apply this policy to the weekend-disabled feeds
      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo-sepolia"
      }

      matcher {
        label = "rateFeed"
        match = "=~"
        value = local.weekend_disabled_feeds_pattern
      }

      # continue=true so the parallel Slack routes (added 2026-05-20) also
      # fire for weekend-muted FX feeds — they share the same mute_timing.
      continue = true
    }

    # Oracle Relayer Alerts [Celo Mainnet]
    policy {
      contact_point = grafana_contact_point.discord_channel_oracle_relayers_prod.name

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo"
      }

      # Exclude the weekend-disabled feeds
      matcher {
        label = "rateFeed"
        match = "!~"
        value = local.weekend_disabled_feeds_pattern
      }

      continue = true
    }

    # Mute notifications on weekends for FX feeds that don't receive new data on weekends
    policy {
      # Apply the mute timing to the policy
      mute_timings = [grafana_mute_timing.weekend_mute.name]

      # Use the same contact point as the main Oracle Relayer policy
      contact_point = grafana_contact_point.discord_channel_oracle_relayers_prod.name

      # Only apply this policy to the weekend-disabled feeds
      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo"
      }

      matcher {
        label = "rateFeed"
        match = "=~"
        value = local.weekend_disabled_feeds_pattern
      }

      # continue=true so the parallel Slack routes (added 2026-05-20) also
      # fire for weekend-muted FX feeds — they share the same mute_timing.
      continue = true
    }

    # Reserve Alerts
    policy {
      contact_point = grafana_contact_point.discord_channel_reserve.name

      matcher {
        label = "service"
        match = "="
        value = "reserve"
      }

      continue = true
    }

    # Trading Mode Alerts [Celo-Sepolia]
    policy {
      contact_point = grafana_contact_point.discord_channel_trading_modes_staging.name

      matcher {
        label = "service"
        match = "="
        value = "exchanges"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo-sepolia"
      }

      continue = true
    }

    # Trading Mode Alerts [Celo Mainnet]
    policy {
      contact_point = grafana_contact_point.discord_channel_trading_modes_prod.name

      matcher {
        label = "service"
        match = "="
        value = "exchanges"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo"
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

    # Aegis Service Alerts - Discord
    policy {
      contact_point = grafana_contact_point.discord_channel_aegis.name

      matcher {
        label = "service"
        match = "="
        value = "aegis"
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

    # Trading Limits Alerts - Discord
    policy {
      contact_point = grafana_contact_point.discord_channel_trading_limits.name

      matcher {
        label = "service"
        match = "="
        value = "trading-limits"
      }

      continue = true
    }

    # ═══════════════════════════════════════════════════════════════════════
    # SLACK DUAL-ROUTE POLICIES (added 2026-05-20)
    #
    # These fire ALONGSIDE the Discord policies above via `continue = true`.
    # Once the soak window confirms Slack parity, the cutover PR removes
    # the Discord policy blocks above, leaving only these.
    #
    # Severity matchers within each service split alerts between the
    # `#alerts-critical` page channel and the relevant domain warning
    # channel. This is a refinement over the existing Discord tree, which
    # routes by service+chain only (no severity branching).
    #
    # Weekend mute timing on FX feeds (PHPUSD, COPUSD, GHSUSD, CELOPHP,
    # CELOCOP, CELOGHS, CELOXOF, EURXOF — see locals.tf) is preserved on
    # every Slack policy that matches oracle-relayers, in parallel with
    # the existing Discord weekend policies (continue=true on those was
    # flipped above for this purpose).
    # ═══════════════════════════════════════════════════════════════════════

    # Oracle Relayer page alerts → #alerts-critical (non-weekend FX)
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

    # Oracle Relayer warning alerts → #alerts-oracles (celo prod, non-weekend FX)
    policy {
      contact_point = grafana_contact_point.slack_alerts_oracles.name

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo"
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

      continue = true
    }

    # Oracle Relayer warning alerts → #alerts-oracles (celo prod, weekend FX, muted)
    policy {
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
        value = "celo"
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

      continue = true
    }

    # Oracle Relayer alerts → #alerts-testnet (celo-sepolia, non-weekend FX, any severity)
    policy {
      contact_point = grafana_contact_point.slack_alerts_testnet.name

      matcher {
        label = "service"
        match = "="
        value = "oracle-relayers"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo-sepolia"
      }

      matcher {
        label = "rateFeed"
        match = "!~"
        value = local.weekend_disabled_feeds_pattern
      }

      continue = true
    }

    # Oracle Relayer alerts → #alerts-testnet (celo-sepolia, weekend FX, muted)
    policy {
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
        value = "celo-sepolia"
      }

      matcher {
        label = "rateFeed"
        match = "=~"
        value = local.weekend_disabled_feeds_pattern
      }

      continue = true
    }

    # Reserve alerts → #alerts-reserve
    policy {
      contact_point = grafana_contact_point.slack_alerts_reserve.name

      matcher {
        label = "service"
        match = "="
        value = "reserve"
      }

      continue = true
    }

    # Trading-modes prod page alerts → Splunk On-Call (NEW route, added
    # alongside the severity=warning → severity=page escalation in
    # alert-rules-trading-modes.tf — a prod circuit-breaker engagement is
    # pager-grade).
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
        value = "exchanges"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo"
      }

      continue = true
    }

    # Trading-modes prod page alerts → #alerts-critical
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
        value = "exchanges"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo"
      }

      continue = true
    }

    # Trading-modes alerts → #alerts-testnet (celo-sepolia, any severity)
    policy {
      contact_point = grafana_contact_point.slack_alerts_testnet.name

      matcher {
        label = "service"
        match = "="
        value = "exchanges"
      }

      matcher {
        label = "chain"
        match = "="
        value = "celo-sepolia"
      }

      continue = true
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

      continue = true
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

      continue = true
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

      continue = true
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

      continue = true
    }
  }
}
