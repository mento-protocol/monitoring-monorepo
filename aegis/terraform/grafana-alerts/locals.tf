# For shared local values that are used across multiple resources
# See https://www.terraform.io/docs/language/values/locals.html
locals {
  # Per-chain registry driving relayer-signer balance alerts. Stale-price and
  # trading-mode alerts iterate this same map (every chain runs SortedOracles +
  # BreakerBox; they differ only in which rateFeed IDs they register, handled by
  # the metric `variants` in config.yaml). Keyed by the Prometheus `chain` label
  # aegis publishes. To add an EVM chain add an entry here — no other edits needed.
  #
  #   title     → human label used in alert names / Discord copy (e.g. "Monad")
  #   env       → "prod" | "staging"; drives severity + notification routing
  #               (prod → warning + prod channels, staging → info + staging)
  #   metric    → Prometheus metric for the native gas token balance
  #               ("CELOToken_balanceOf" for Celo, "Native_balanceOf" for chains
  #               whose gas token isn't ERC20-compatible, e.g. MON)
  #   symbol    → gas-token ticker shown in alert copy (e.g. "CELO", "MON")
  #   threshold → low-balance alert threshold, in whole tokens
  #   explorer  → block-explorer host for address links in alert copy
  chains = {
    "celo" = {
      title     = "Celo"
      env       = "prod"
      metric    = "CELOToken_balanceOf"
      symbol    = "CELO"
      threshold = 10
      explorer  = "celoscan.io"
    }
    "celo-sepolia" = {
      title     = "Celo-Sepolia"
      env       = "staging"
      metric    = "CELOToken_balanceOf"
      symbol    = "CELO"
      threshold = 10
      explorer  = "sepolia.celoscan.io"
    }
    "monad" = {
      title     = "Monad"
      env       = "prod"
      metric    = "Native_balanceOf"
      symbol    = "MON"
      threshold = 50
      explorer  = "monadscan.com"
    }
    "monad-testnet" = {
      title     = "Monad-Testnet"
      env       = "staging"
      metric    = "Native_balanceOf"
      symbol    = "MON"
      threshold = 50
      explorer  = "testnet.monadscan.com"
    }
  }

  # Chains split by environment, used to fan out Slack notification routes
  # (prod chains → #alerts-oracles, staging chains → #alerts-testnet).
  prod_chains    = { for k, c in local.chains : k => c if c.env == "prod" }
  staging_chains = { for k, c in local.chains : k => c if c.env == "staging" }

  # Weekend-disabled feeds that don't receive updates during market closing
  # hours (FX markets are closed on weekends). Matched against the `rateFeed`
  # label across all chains, so the same feed name is muted wherever it appears.
  weekend_disabled_feeds = [
    "PHPUSD",
    "COPUSD",
    "GHSUSD",
    "CELOPHP",
    "CELOCOP",
    "CELOGHS",
    "CELOXOF",
    "EURXOF",
    "GBPUSD",
    "EURUSD",
    "JPYUSD",
    "CHFUSD"
  ]

  # Create a regex pattern for the weekend-disabled feeds
  weekend_disabled_feeds_pattern = join("|", local.weekend_disabled_feeds)

  # Each entry maps alertnames → three template families:
  #   - title_template / message_template       → Discord (kept during dual-route, removed after cutover)
  #   - slack_*                                 → Slack mrkdwn (message-templates-slack.tf)
  #   - victorops_*                             → Splunk On-Call plain text (message-templates-victorops.tf)
  # The three dispatchers (alert_config / alert_config_slack / alert_config_victorops) read
  # from this single source of truth so alertname→service mapping stays in one place.
  alert_types = {
    oracle_stale_price = {
      # One alert name per chain (e.g. "Oldest Report Expired [Monad]"),
      # generated from the chains registry so the rule names always match a
      # dispatcher branch.
      names = [
        for k, c in local.chains : "Oldest Report Expired [${c.title}]"
      ],
      title_template             = "discord.oracle_stale_price_alert_title",
      message_template           = "discord.oracle_stale_price_alert_message",
      slack_title_template       = "slack.oracle_stale_price_alert_title",
      slack_message_template     = "slack.oracle_stale_price_alert_message",
      victorops_title_template   = "victorops.oracle_stale_price_alert_title",
      victorops_message_template = "victorops.oracle_stale_price_alert_message"
    },
    oracle_relayer_low_balance = {
      # One alert name per chain, e.g. "Low CELO Balance [Celo]",
      # "Low MON Balance [Monad]". Generated from the chains registry so a new
      # chain's alert routes through this dispatcher automatically.
      names = [
        for k, c in local.chains : "Low ${c.symbol} Balance [${c.title}]"
      ],
      title_template             = "discord.oracle_relayer_low_balance_alert_title",
      message_template           = "discord.oracle_relayer_low_balance_alert_message",
      slack_title_template       = "slack.oracle_relayer_low_balance_alert_title",
      slack_message_template     = "slack.oracle_relayer_low_balance_alert_message",
      victorops_title_template   = "victorops.oracle_relayer_low_balance_alert_title",
      victorops_message_template = "victorops.oracle_relayer_low_balance_alert_message"
    },
    low_reserve_balance = {
      names = [
        "Low USDC Reserve Balance Alert",
        "Low USDT Reserve Balance Alert",
        "Low axlUSDC Reserve Balance Alert"
      ],
      title_template             = "discord.reserve_balance_alert_title",
      message_template           = "discord.reserve_balance_alert_message",
      slack_title_template       = "slack.reserve_balance_alert_title",
      slack_message_template     = "slack.reserve_balance_alert_message",
      victorops_title_template   = "victorops.reserve_balance_alert_title",
      victorops_message_template = "victorops.reserve_balance_alert_message"
    },
    trading_halted = {
      # One alert name per chain (e.g. "Trading Mode Alert [Monad]"), generated
      # from the chains registry so the rule names always match a dispatcher
      # branch.
      names = [
        for k, c in local.chains : "Trading Mode Alert [${c.title}]"
      ],
      title_template             = "discord.trading_mode_alert_title",
      message_template           = "discord.trading_mode_alert_message",
      slack_title_template       = "slack.trading_mode_alert_title",
      slack_message_template     = "slack.trading_mode_alert_message",
      victorops_title_template   = "victorops.trading_mode_alert_title",
      victorops_message_template = "victorops.trading_mode_alert_message"
    },
    aegis_service_issues = {
      names = [
        "Number of failed rpc calls",
        "Aegis does not report new data"
      ],
      title_template             = "discord.aegis_service_alert_title",
      message_template           = "discord.aegis_service_alert_message",
      slack_title_template       = "slack.aegis_service_alert_title",
      slack_message_template     = "slack.aegis_service_alert_message",
      victorops_title_template   = "victorops.aegis_service_alert_title",
      victorops_message_template = "victorops.aegis_service_alert_message"
    },
    trading_limits = {
      names = [
        "L0 Trading Limit Alert [Celo]",
        "L1 Trading Limit Alert [Celo]",
        "LG Trading Limit Alert [Celo]"
      ],
      title_template             = "discord.trading_limits_alert_title",
      message_template           = "discord.trading_limits_alert_message",
      slack_title_template       = "slack.trading_limits_alert_title",
      slack_message_template     = "slack.trading_limits_alert_message",
      victorops_title_template   = "victorops.trading_limits_alert_title",
      victorops_message_template = "victorops.trading_limits_alert_message"
    }
  }
  alert_config = {
    title = <<-EOT
    {{ $alertName := .CommonLabels.alertname }}
    %{for alert_type, config in local.alert_types~}
    %{for index, name in config.names~}
    %{if index == 0 && alert_type == keys(local.alert_types)[0]~}
    {{ if eq $alertName "${name}" }}
    %{else~}
    {{ else if eq $alertName "${name}" }}
    %{endif~}
    {{ template "${config.title_template}" . }}
    %{endfor~}
    %{endfor~}
    {{ else }}
    {{ $alertName }}
    {{ .CommonLabels }}
    {{ end }}
    EOT

    message = <<-EOT
    {{ $alertName := .CommonLabels.alertname }}
    %{for alert_type, config in local.alert_types~}
    %{for index, name in config.names~}
    %{if index == 0 && alert_type == keys(local.alert_types)[0]~}
    {{ if (eq $alertName "${name}") }}
    %{else~}
    {{ else if (eq $alertName "${name}") }}
    %{endif~}
    {{ template "${config.message_template}" . }}
    %{endfor~}
    %{endfor~}
    {{ else if (eq $alertName "DatasourceError") }}
    The Grafana alert query might be broken. Please check the alert configuration.
    {{ else }}
    {{ $alertName}}
    {{ .CommonLabels }}
    {{ end }}
    EOT
  }

  # Slack dispatcher — same alertname-branching as alert_config but selects the
  # `slack.*` templates from message-templates-slack.tf. Referenced by every
  # grafana_contact_point.slack_alerts_* in contact-points.tf.
  alert_config_slack = {
    title = <<-EOT
    {{ $alertName := .CommonLabels.alertname }}
    %{for alert_type, config in local.alert_types~}
    %{for index, name in config.names~}
    %{if index == 0 && alert_type == keys(local.alert_types)[0]~}
    {{ if eq $alertName "${name}" }}
    %{else~}
    {{ else if eq $alertName "${name}" }}
    %{endif~}
    {{ template "${config.slack_title_template}" . }}
    %{endfor~}
    %{endfor~}
    {{ else }}
    {{ $alertName }}
    {{ .CommonLabels }}
    {{ end }}
    EOT

    message = <<-EOT
    {{ $alertName := .CommonLabels.alertname }}
    %{for alert_type, config in local.alert_types~}
    %{for index, name in config.names~}
    %{if index == 0 && alert_type == keys(local.alert_types)[0]~}
    {{ if (eq $alertName "${name}") }}
    %{else~}
    {{ else if (eq $alertName "${name}") }}
    %{endif~}
    {{ template "${config.slack_message_template}" . }}
    %{endfor~}
    %{endfor~}
    {{ else if (eq $alertName "DatasourceError") }}
    The Grafana alert query might be broken. Please check the alert configuration.
    {{ else }}
    {{ $alertName}}
    {{ .CommonLabels }}
    {{ end }}
    EOT
  }

  # VictorOps (Splunk On-Call) dispatcher — plain text variant.
  # Referenced by `grafana_contact_point.splunk_on_call`.
  alert_config_victorops = {
    title = <<-EOT
    {{ $alertName := .CommonLabels.alertname }}
    %{for alert_type, config in local.alert_types~}
    %{for index, name in config.names~}
    %{if index == 0 && alert_type == keys(local.alert_types)[0]~}
    {{ if eq $alertName "${name}" }}
    %{else~}
    {{ else if eq $alertName "${name}" }}
    %{endif~}
    {{ template "${config.victorops_title_template}" . }}
    %{endfor~}
    %{endfor~}
    {{ else }}
    {{ $alertName }}
    {{ .CommonLabels }}
    {{ end }}
    EOT

    message = <<-EOT
    {{ $alertName := .CommonLabels.alertname }}
    %{for alert_type, config in local.alert_types~}
    %{for index, name in config.names~}
    %{if index == 0 && alert_type == keys(local.alert_types)[0]~}
    {{ if (eq $alertName "${name}") }}
    %{else~}
    {{ else if (eq $alertName "${name}") }}
    %{endif~}
    {{ template "${config.victorops_message_template}" . }}
    %{endfor~}
    %{endfor~}
    {{ else if (eq $alertName "DatasourceError") }}
    The Grafana alert query might be broken. Please check the alert configuration.
    {{ else }}
    {{ $alertName}}
    {{ .CommonLabels }}
    {{ end }}
    EOT
  }
}
