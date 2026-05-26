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
    "CHFUSD",
    # All seven below fired `Oldest Report Expired [Celo]` continuously from
    # Fri 2026-05-22 21:09 UTC (NY FX close) through Sun 2026-05-24 23:03 UTC
    # (Sydney FX reopen). Their relayers pause publishing while the
    # corresponding FX market is closed, so the on-chain SortedOracles report
    # ages past the expiry window and pages on-call.
    "AUDUSD",
    "BRLUSD",
    "CADUSD",
    "KESUSD",
    "NGNUSD",
    "XOFUSD",
    "ZARUSD"
  ]

  # Create a regex pattern for the weekend-disabled feeds
  weekend_disabled_feeds_pattern = join("|", local.weekend_disabled_feeds)

  # Per-feed Celo relayer signer wallets. Used by the Slack stale-price alert
  # template to link "<pair> relayer on Celo" to the signer's celoscan page.
  # Mirror of `global.vars.RelayerSigner<feed>` in `aegis/config.yaml`.
  celo_relayer_signers = {
    AUDUSD   = "0x6fa93B73F00f9c61f726bCE15f327686de05b696"
    AUSDUSD  = "0xBF8a08d7DeC72efF538B48Ee332dd4eE938e0b1f"
    BRLUSD   = "0x7a82bfDeC85bF54B240065CdC20A811BF56528C8"
    CADUSD   = "0x857ad1CeE80c3e72f2d8e558B773E63dAB8185fe"
    CELOAUD  = "0x2821d073C30876187198f573Bf544200ff95bf7e"
    CELOCAD  = "0x0faBAd32E6cb81CC20756E65b4df7B2553CFf4eE"
    CELOCHF  = "0x658f09B516801Eb390d150EB601dD11428A03028"
    CELOETH  = "0x55A93586a5535d1B8E10f2eB5C76b33E558F19e3"
    CELOCOP  = "0xd8dfB551157B0B80D41787C08885e09F994B7cC5"
    CELOGBP  = "0x7924EaC31d10682aa3049E957E3bB72bA3FF4730"
    CELOGHS  = "0x43C9190F712C1f3c923f02073499A97cf8a9348b"
    CELOJPY  = "0x9174bc946D0a4274ed221C75F66128174BdFB099"
    CELOKES  = "0x34cD259E3e92B9FFEA38E8c84665A1Ca289bfB32"
    CELONGN  = "0x5008F97b7713e2166041375a316990868F92B3d2"
    CELOPHP  = "0xCCD3D48D6a5340156d85DC5A43743e65Bd4a6E51"
    CELOXOF  = "0xB3B87B49De2C5012467505cAb551773023B89aEB"
    CELOZAR  = "0x17C8c519CD32abDE464D4FA19c7461A399eE2c5a"
    CHFUSD   = "0x75bB7BC38Bb886D86B6cBaBfC334B807F6926b7d"
    COPUSD   = "0x95C365fBE39d9b8002f4683b0Bb6020680D9C4E0"
    EUROCEUR = "0xb0491394B775AE9BCf85Fb3835d232cEBe514Cf5"
    EURUSD   = "0x7973B53c09Ec35cdCa71D46b98801ddeD856BB20"
    EURXOF   = "0xDE96A69fAba07A8dfF8Bd9309c245bDf4175d3E7"
    GBPUSD   = "0x8103bE713aa149928D26c1b3873Ee240F8F7429E"
    GHSUSD   = "0x36b103087c5c46b1515c32a2d91928181F8d39f8"
    JPYUSD   = "0xF4615456f71157F758b7FaCaF62d57E339a664D7"
    KESUSD   = "0x3c05004b74e0fa466B24ca19929ee662d5BbEc45"
    NGNUSD   = "0xbfA9203552e9b02035034befDFE012aC5029B4F9"
    PHPUSD   = "0xb2cE6fa691b58Ff4fadBd610a8e09427d2918025"
    USDCUSD  = "0x9b4Ee654F6bd2485e804080dDbd5E048b21271B3"
    USDTUSD  = "0x36a5C808e25AF0F5e406Eaa831d1749542378794"
    XOFUSD   = "0x2C5dB0140b6B25CA6a37304198095B23E2604dF2"
    ZARUSD   = "0xc0342D31Cc875f3dC85E3Ab352e60698444197AE"
  }

  # Per-feed Monad relayer signer wallets. Sourced from live Aegis
  # `Native_balanceOf{chain=~"monad|monad-testnet"}` ownerValue labels, which
  # are populated from the Oracle Relayer signer set. Keep this map separate
  # from Celo even when a signer address currently matches so the Slack
  # template can select the right explorer per chain and future signer drift
  # stays local.
  # Both monad and monad-testnet currently share this signer set; split into
  # separate maps if testnet signers diverge.
  monad_relayer_signers = {
    AUSDUSD = "0xBF8a08d7DeC72efF538B48Ee332dd4eE938e0b1f"
    CHFUSD  = "0x75bB7BC38Bb886D86B6cBaBfC334B807F6926b7d"
    EURUSD  = "0x7973B53c09Ec35cdCa71D46b98801ddeD856BB20"
    GBPUSD  = "0x8103bE713aa149928D26c1b3873Ee240F8F7429E"
    JPYUSD  = "0xF4615456f71157F758b7FaCaF62d57E339a664D7"
    USDCUSD = "0x9b4Ee654F6bd2485e804080dDbd5E048b21271B3"
    USDTUSD = "0x36a5C808e25AF0F5e406Eaa831d1749542378794"
  }

  # GCP project for mainnet relayer cloud functions. Used by the Slack
  # stale-price template's "relayer cloud function" link. Sourced from
  # `mento-protocol/oracle-relayer` repo (`.project_vars_cache`,
  # `infra/main.tf` random_project_id suffix).
  oracle_relayer_mainnet_project_id = "oracle-relayer-mainnet-0527"

  # Pre-rendered template fragment that sets `$relayer` per rate feed. Used by
  # the Slack stale-price template. Built from the map above as a series of
  # independent `{{ if eq .Labels.rateFeed "..." -}}{{ $relayer = "..." -}}{{ end -}}`
  # blocks so the runtime template doesn't need Sprig `dict` / `index` calls
  # (Grafana's notification template engine exposes a curated subset of Sprig,
  # and `dict` isn't documented as part of it). Each block is independent so
  # they all evaluate; the matching one assigns `$relayer`. Wrap the fragments
  # in chain-specific `{{ if eq .Labels.chain ... }}` blocks at the call site so
  # explorer links are only rendered for the chain whose signer map matched.
  celo_relayer_signer_branches = join("\n", [
    for k, v in local.celo_relayer_signers :
    format("{{ if eq .Labels.rateFeed %q -}}{{ $relayer = %q -}}{{ end -}}", k, v)
  ])

  monad_relayer_signer_branches = join("\n", [
    for k, v in local.monad_relayer_signers :
    format("{{ if eq .Labels.rateFeed %q -}}{{ $relayer = %q -}}{{ end -}}", k, v)
  ])

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
