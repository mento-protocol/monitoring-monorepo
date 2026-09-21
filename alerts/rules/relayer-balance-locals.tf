# Low-balance policy for the oracle relayer wallets, in days of runway.
#
# Two kinds of wallet are watched (rules in rules-oracle-relayers.tf):
#   - relayer signers, which pay for relay() transactions, and
#   - the refiller wallet, which the daily refill-relayers cloud functions
#     (oracle-relayer repo) pay signer top-ups from.
#
# The burn figures mirror the DAILY_COST table in the oracle-relayer refill
# script; change them together. Every chain in local.chains needs an entry here:
# a missing one fails the plan rather than silently dropping its alerts.
locals {
  # The refiller pays every signer top-up, so its outflow is the whole chain's
  # relay burn. Signers are topped up in bursts (a group that crosses the 7-day
  # refill line together is paid in one run), so the alert has to sit well above
  # the largest burst: 14 days of burn covers it at least 1.5x on every chain
  # and still leaves a week or more before a refill could fail.
  refiller_alert_runway_days = 14
  # The daily refill tops a signer up once it drops below 7 days, so a signer
  # below 5 days means the automation is not keeping up.
  signer_alert_runway_days = 5

  #   signer_daily_burn      → native tokens one signer burns per weekday
  #   signer_classes         → feeds that burn at a different pace; each gets its
  #                            own low-balance rule. `feeds` are the rateFeed
  #                            suffixes of aegis's `RelayerSigner<FEED>` owners,
  #                            and must exist in aegis/config.yaml to ever alert
  #   refiller_monthly_burn  → native tokens the refiller pays out per month
  #   refiller_min_threshold → floor for the refiller alert; on testnets burn is
  #                            so small that one round of top-ups is the real need
  #   refiller_urgent_threshold → below this the refiller cannot pay the largest
  #                            plausible single run of top-ups (signers that cross
  #                            the refill line together are paid in one run), so
  #                            the next refill may fail. 0 disables the urgent
  #                            rule; testnets only get the early warning
  relayer_burn = {
    "celo" = {
      signer_daily_burn = 15
      signer_classes = {
        # Built from two Chainlink aggregators; they relay on every new round
        # of either one, so roughly twice as often.
        composite = {
          label       = "two-aggregator feeds"
          feeds       = ["EUROCEUR", "EURXOF"]
          daily_burn  = 26
          runway_days = 5
        }
        # Scheduled once a day, so ~0.05 CELO/day. Five days of that is a
        # fraction of a relay, so use 20 days (1 CELO), which still sits below
        # the refill script's 30-day top-up line for these feeds.
        gas = {
          label       = "gas feeds"
          feeds       = ["CELOAUD", "CELOBRL", "CELOCAD", "CELOCHF", "CELOCOP", "CELOETH", "CELOEUR", "CELOGBP", "CELOGHS", "CELOJPY", "CELOKES", "CELONGN", "CELOPHP", "CELOXAUT", "CELOXOF", "CELOZAR"]
          daily_burn  = 0.05
          runway_days = 20
        }
      }
      refiller_monthly_burn  = 7200
      refiller_min_threshold = 0
      # ~10 standard signers sit at nearly the same balance and cross together
      refiller_urgent_threshold = 1500
    }
    "celo-sepolia" = {
      # Testnet relayers are scheduled once a day: ~0.01 tokens/day each.
      signer_daily_burn = 0.01
      signer_classes    = {}
      # 34 signers x 0.01/day. The refill script rounds every top-up up to 2
      # tokens, so the floor is one full round of top-ups.
      refiller_monthly_burn     = 10
      refiller_min_threshold    = 70
      refiller_urgent_threshold = 0
    }
    "monad" = {
      signer_daily_burn = 22
      signer_classes = {
        # Their Chainlink aggregators only publish hourly: 24 relays a day.
        hourly = {
          label       = "hourly stablecoin feeds"
          feeds       = ["AUSDUSD", "USDCUSD", "USDTUSD"]
          daily_burn  = 1.5
          runway_days = 5
        }
      }
      refiller_monthly_burn  = 2100
      refiller_min_threshold = 0
      # the four fiat signers cross together: 4 x ~160
      refiller_urgent_threshold = 700
    }
    "polygon" = {
      signer_daily_burn      = 135
      signer_classes         = {}
      refiller_monthly_burn  = 7000
      refiller_min_threshold = 0
      # both feeds topping up in one run: 2 x ~950
      refiller_urgent_threshold = 2000
    }
    "monad-testnet" = {
      signer_daily_burn         = 0.01
      signer_classes            = {}
      refiller_monthly_burn     = 2
      refiller_min_threshold    = 15
      refiller_urgent_threshold = 0
    }
    "polygon-testnet" = {
      signer_daily_burn         = 0.01
      signer_classes            = {}
      refiller_monthly_burn     = 1
      refiller_min_threshold    = 5
      refiller_urgent_threshold = 0
    }
  }

  # Products are rounded via format() so float noise (0.01 * 5 = 0.04999…) never
  # reaches the PromQL or the alert copy.
  #
  # One low-balance rule per chain, plus one per signer class. The default rule
  # keeps the historical name and excludes every feed a class already covers.
  signer_balance_rules = merge([
    for k, c in local.chains : merge(
      {
        "${k}/default" = {
          chain_key = k
          chain     = c
          name      = "Low ${c.symbol} Balance [${c.title}]"
          include   = "^RelayerSigner.*$"
          # Feeds a class below already covers. "^$" matches no owner, so a
          # chain without classes excludes nothing. Both matchers stay literal
          # in the rule's PromQL so the alert-rules linter can parse it.
          exclude     = length(local.relayer_burn[k].signer_classes) == 0 ? "^$" : "^RelayerSigner(${join("|", flatten([for cls in values(local.relayer_burn[k].signer_classes) : cls.feeds]))})$"
          threshold   = tonumber(format("%.2f", local.relayer_burn[k].signer_daily_burn * local.signer_alert_runway_days))
          runway_days = local.signer_alert_runway_days
        }
      },
      {
        for class_key, cls in local.relayer_burn[k].signer_classes : "${k}/${class_key}" => {
          chain_key   = k
          chain       = c
          name        = "Low ${c.symbol} Balance [${c.title}, ${cls.label}]"
          include     = "^RelayerSigner(${join("|", cls.feeds)})$"
          exclude     = "^$"
          threshold   = tonumber(format("%.2f", cls.daily_burn * cls.runway_days))
          runway_days = cls.runway_days
        }
      },
    )
  ]...)

  refiller_balance_rules = {
    for k, c in local.chains : k => {
      chain        = c
      name         = "Low Refiller Balance [${c.title}]"
      monthly_burn = local.relayer_burn[k].refiller_monthly_burn
      # Tokens the refiller pays out per day, used to express the balance as
      # days of refills in the alert copy.
      daily_burn = tonumber(format("%.4f", local.relayer_burn[k].refiller_monthly_burn / 30))
      threshold = max(
        ceil(local.relayer_burn[k].refiller_monthly_burn * local.refiller_alert_runway_days / 30),
        local.relayer_burn[k].refiller_min_threshold,
      )
    }
  }

  # Second level, prod only: the wallet can no longer cover the next round of
  # top-ups. It is a separate rule with its own name rather than a label on the
  # early-warning rule. Grafana identifies a firing alert by rule plus labels,
  # so relabelling the early warning would resolve and re-fire whatever is
  # firing at deploy time and post a false "funded again" message.
  refiller_urgent_rules = {
    for k, c in local.chains : k => {
      chain        = c
      name         = "Refiller Cannot Cover Refills [${c.title}]"
      monthly_burn = local.relayer_burn[k].refiller_monthly_burn
      daily_burn   = tonumber(format("%.4f", local.relayer_burn[k].refiller_monthly_burn / 30))
      threshold    = local.relayer_burn[k].refiller_urgent_threshold
    } if local.relayer_burn[k].refiller_urgent_threshold > 0
  }

  # Both levels, in the order the rule group lists them. The provider tracks a
  # rule's UID by its position in the group, so the early-warning rules must
  # keep their positions: the "~" prefix sorts the urgent keys after every
  # chain key, which appends them instead of interleaving them.
  refiller_rules = merge(
    { for k, r in local.refiller_balance_rules : k => merge(r, { chain_key = k, urgent = false }) },
    { for k, r in local.refiller_urgent_rules : "~urgent/${k}" => merge(r, { chain_key = k, urgent = true }) },
  )
}
