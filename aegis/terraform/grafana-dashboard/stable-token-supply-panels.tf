locals {
  stable_token_supply_panels = [
    {
      id      = local.stable_token_supply_id_start
      type    = "row"
      title   = "Stable Token Supply"
      gridPos = { x = 0, y = local.stable_token_supply_y_start, h = 1, w = 24 }
    },
    merge(local.common_panel_config, {
      id          = local.stable_token_supply_id_start + 1
      type        = "timeseries"
      title       = "Total Supply - All Stable Tokens [celo]"
      description = "Total outstanding supply of all Mento stable tokens. Shows the absolute number of tokens in circulation for each stablecoin."
      gridPos = {
        x = 0,
        y = local.stable_token_supply_y_start + 1,
        h = 16,
        w = 12
      }
      fieldConfig = {
        defaults = {
          custom = {
            drawStyle         = "line"
            lineInterpolation = "linear"
            fillOpacity       = 8
            gradientMode      = "opacity"
            spanNulls         = true
            showPoints        = "never"
            pointSize         = 5
            lineWidth         = 2
            stacking = {
              mode  = "none"
              group = "A"
            }
            axisPlacement = "auto"
            axisLabel     = "Token Supply (log scale)"
            axisColorMode = "text"
            axisSoftMin   = 1000
            axisGridShow  = false
            scaleDistribution = {
              type = "log"
              log  = 10
            }
            axisCenteredZero = false
            hideFrom = {
              tooltip = false
              viz     = false
              legend  = false
            }
          }
          color    = { mode = "palette-classic" }
          mappings = []
          unit     = "locale"
          decimals = 1
          min      = 0
        }
        overrides = [
          {
            matcher = { id = "byName", options = "USDm" }
            properties = [
              {
                id    = "color"
                value = { mode = "fixed", fixedColor = "green" }
              },
              {
                id    = "decimals"
                value = 1
              }
            ]
          },
          {
            matcher = { id = "byName", options = "EURm" }
            properties = [
              {
                id    = "color"
                value = { mode = "fixed", fixedColor = "blue" }
              },
              {
                id    = "decimals"
                value = 1
              }
            ]
          },
          {
            matcher = { id = "byName", options = "BRLm" }
            properties = [
              {
                id    = "color"
                value = { mode = "fixed", fixedColor = "yellow" }
              },
              {
                id    = "decimals"
                value = 1
              }
            ]
          },
          {
            matcher = { id = "byName", options = "KESm" }
            properties = [
              {
                id    = "color"
                value = { mode = "fixed", fixedColor = "orange" }
              },
              {
                id    = "decimals"
                value = 1
              }
            ]
          },
          {
            matcher = { id = "byName", options = "PHPm" }
            properties = [
              {
                id    = "color"
                value = { mode = "fixed", fixedColor = "purple" }
              },
              {
                id    = "decimals"
                value = 1
              }
            ]
          },
          {
            matcher = { id = "byName", options = "COPm" }
            properties = [
              {
                id    = "color"
                value = { mode = "fixed", fixedColor = "red" }
              },
              {
                id    = "decimals"
                value = 1
              }
            ]
          }
        ]
      }
      options = {
        tooltip = { mode = "multi", sort = "desc" }
        legend = {
          showLegend  = true
          displayMode = "table"
          placement   = "bottom"
          calcs       = ["lastNotNull", "mean"]
          decimals    = 1
        }
      }
      pluginVersion = "10.0.0"
      transparent   = false
      targets = [
        {
          expr         = "USDm_totalSupply{chain=\"celo\"}"
          legendFormat = "USDm"
          refId        = "USDm"
        },
        {
          expr         = "EURm_totalSupply{chain=\"celo\"}"
          legendFormat = "EURm"
          refId        = "EURm"
        },
        {
          expr         = "BRLm_totalSupply{chain=\"celo\"}"
          legendFormat = "BRLm"
          refId        = "BRLm"
        },
        {
          expr         = "XOFm_totalSupply{chain=\"celo\"}"
          legendFormat = "XOFm"
          refId        = "XOFm"
        },
        {
          expr         = "KESm_totalSupply{chain=\"celo\"}"
          legendFormat = "KESm"
          refId        = "KESm"
        },
        {
          expr         = "PHPm_totalSupply{chain=\"celo\"}"
          legendFormat = "PHPm"
          refId        = "PHPm"
        },
        {
          expr         = "COPm_totalSupply{chain=\"celo\"}"
          legendFormat = "COPm"
          refId        = "COPm"
        },
        {
          expr         = "GHSm_totalSupply{chain=\"celo\"}"
          legendFormat = "GHSm"
          refId        = "GHSm"
        },
        {
          expr         = "GBPm_totalSupply{chain=\"celo\"}"
          legendFormat = "GBPm"
          refId        = "GBPm"
        },
        {
          expr         = "ZARm_totalSupply{chain=\"celo\"}"
          legendFormat = "ZARm"
          refId        = "ZARm"
        },
        {
          expr         = "CADm_totalSupply{chain=\"celo\"}"
          legendFormat = "CADm"
          refId        = "CADm"
        },
        {
          expr         = "AUDm_totalSupply{chain=\"celo\"}"
          legendFormat = "AUDm"
          refId        = "AUDm"
        },
        {
          expr         = "CHFm_totalSupply{chain=\"celo\"}"
          legendFormat = "CHFm"
          refId        = "CHFm"
        },
        {
          expr         = "NGNm_totalSupply{chain=\"celo\"}"
          legendFormat = "NGNm"
          refId        = "NGNm"
        },
        {
          expr         = "JPYm_totalSupply{chain=\"celo\"}"
          legendFormat = "JPYm"
          refId        = "JPYm"
        }
      ]
    }),
    # Second panel: Total Supply in USD (timeseries graph)
    merge(local.common_panel_config, {
      id          = local.stable_token_supply_id_start + 2
      type        = "timeseries"
      title       = "Total Supply - USD Value [celo]"
      description = "Individual USD value of each stable token over time. Each line shows the actual USD-equivalent supply for that token. Hover to see combined total."
      gridPos = {
        x = 12,
        y = local.stable_token_supply_y_start + 1,
        h = 16,
        w = 12
      }
      fieldConfig = {
        defaults = {
          custom = {
            drawStyle         = "line"
            lineInterpolation = "linear"
            fillOpacity       = 8
            gradientMode      = "opacity"
            spanNulls         = true
            showPoints        = "never"
            pointSize         = 5
            lineWidth         = 2
            stacking = {
              mode  = "none"
              group = "A"
            }
            axisPlacement    = "auto"
            axisLabel        = "USD Value (log scale)"
            axisColorMode    = "text"
            axisSoftMin      = 1000
            axisGridShow     = false
            axisCenteredZero = false
            scaleDistribution = {
              type = "log"
              log  = 10
            }
            hideFrom = {
              tooltip = false
              viz     = false
              legend  = false
            }
          }
          color    = { mode = "palette-classic" }
          mappings = []
          unit     = "currencyUSD"
          decimals = 2
          min      = 0
          max      = 50000000
        }
        overrides = [
          {
            matcher = { id = "byRegexp", options = ".*" }
            properties = [
              {
                id    = "decimals"
                value = 2
              }
            ]
          },
          {
            matcher = { id = "byName", options = "Total Supply (USD)" }
            properties = [
              {
                id    = "custom.lineWidth"
                value = 4
              },
              {
                id    = "color"
                value = { mode = "fixed", fixedColor = "white" }
              }
            ]
          }
        ]
      }
      options = {
        tooltip = { mode = "multi", sort = "desc" }
        legend = {
          showLegend  = true
          displayMode = "table"
          placement   = "bottom"
          calcs       = ["lastNotNull", "mean"]
          decimals    = 2
        }
      }
      pluginVersion = "10.0.0"
      transparent   = false
      transformations = [
        {
          id = "joinByField"
          options = {
            byField = "Time"
            mode    = "outer"
          }
        }
      ]
      targets = [
        {
          # USDm is 1:1 with USD (no conversion needed)
          expr         = "USDm_totalSupply{chain=\"celo\"}"
          legendFormat = "USDm"
          refId        = "USDm"
        },
        {
          # EURm: Multiply EURm supply by the dynamic EUR/USD exchange rate from SortedOracles
          expr         = "EURm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"EURUSD\"}"
          legendFormat = "EURm"
          refId        = "EURm"
        },
        {
          # BRLm: Multiply by dynamic BRL/USD rate
          expr         = "BRLm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"BRLUSD\"}"
          legendFormat = "BRLm"
          refId        = "BRLm"
        },
        {
          # XOFm: Multiply by dynamic XOF/USD rate
          expr         = "XOFm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"XOFUSD\"}"
          legendFormat = "XOFm"
          refId        = "XOFm"
        },
        {
          # KESm: Multiply by dynamic KES/USD rate
          expr         = "KESm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"KESUSD\"}"
          legendFormat = "KESm"
          refId        = "KESm"
        },
        {
          # PHPm: Multiply by dynamic PHP/USD rate
          expr         = "PHPm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"PHPUSD\"}"
          legendFormat = "PHPm"
          refId        = "PHPm"
        },
        {
          # COPm: Multiply by dynamic COP/USD rate
          expr         = "COPm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"COPUSD\"}"
          legendFormat = "COPm"
          refId        = "COPm"
        },
        {
          # GHSm: Multiply by dynamic GHS/USD rate
          expr         = "GHSm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"GHSUSD\"}"
          legendFormat = "GHSm"
          refId        = "GHSm"
        },
        {
          # GBPm: Multiply by dynamic GBP/USD rate
          expr         = "GBPm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"GBPUSD\"}"
          legendFormat = "GBPm"
          refId        = "GBPm"
        },
        {
          # ZARm: Multiply by dynamic South African rand/USD rate
          expr         = "ZARm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"ZARUSD\"}"
          legendFormat = "ZARm"
          refId        = "ZARm"
        },
        {
          # CADm: Multiply by dynamic CAD/USD rate
          expr         = "CADm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"CADUSD\"}"
          legendFormat = "CADm"
          refId        = "CADm"
        },
        {
          # AUDm: Multiply by dynamic AUD/USD rate
          expr         = "AUDm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"AUDUSD\"}"
          legendFormat = "AUDm"
          refId        = "AUDm"
        },
        {
          # CHFm: Multiply by dynamic CHF/USD rate
          expr         = "CHFm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"CHFUSD\"}"
          legendFormat = "CHFm"
          refId        = "CHFm"
        },
        {
          # NGNm: Multiply by dynamic NGN/USD rate
          expr         = "NGNm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"NGNUSD\"}"
          legendFormat = "NGNm"
          refId        = "NGNm"
        },
        {
          # JPYm: Multiply by dynamic JPY/USD rate
          expr         = "JPYm_totalSupply{chain=\"celo\"} * on() group_left SortedOracles_medianRate_rate{chain=\"celo\", token=\"JPYUSD\"}"
          legendFormat = "JPYm"
          refId        = "JPYm"
        },
        {
          # Combined total of all stable tokens in USD using dynamic exchange rates
          expr         = <<-EOT
            USDm_totalSupply{chain="celo"} +
            (EURm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="EURUSD"}) +
            (BRLm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="BRLUSD"}) +
            (XOFm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="XOFUSD"}) +
            (KESm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="KESUSD"}) +
            (PHPm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="PHPUSD"}) +
            (COPm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="COPUSD"}) +
            (GHSm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="GHSUSD"}) +
            (GBPm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="GBPUSD"}) +
            (ZARm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="ZARUSD"}) +
            (CADm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="CADUSD"}) +
            (AUDm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="AUDUSD"}) +
            (CHFm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="CHFUSD"}) +
            (NGNm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="NGNUSD"}) +
            (JPYm_totalSupply{chain="celo"} * on() group_left SortedOracles_medianRate_rate{chain="celo", token="JPYUSD"})
          EOT
          legendFormat = "Total Supply (USD)"
          refId        = "Total"
        }
      ]
    })
  ]
}
