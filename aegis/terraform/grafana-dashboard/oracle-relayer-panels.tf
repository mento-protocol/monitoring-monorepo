locals {
  oracle_relayer_panels = concat(
    [
      {
        id      = local.oracle_relayer_id_start
        type    = "row"
        title   = "Oracles - Chainlink Relayers"
        gridPos = { x = 0, y = local.oracle_relayer_y_start, h = 1, w = 24 }
      }
    ],
    flatten([
      for i, chain in keys(local.celo_chains) : [
        merge(local.common_panel_config, local.state_timeline_config, {
          id          = local.oracle_relayer_id_start + 1 + i
          title       = "Rate Feed Freshness [${chain}]"
          description = "Shows if the oldest report in SortedOracles is expired for each relayed rate feed. 1 means expired, 0 means not expired."
          gridPos     = { x = i * 12, y = local.oracle_relayer_y_start + 1, h = 20, w = 24 / length(local.celo_chains) }
          fieldConfig = {
            defaults = merge(local.state_timeline_config.fieldConfig.defaults, {
              decimals = 0
              max      = 1
              min      = 0
              thresholds = {
                mode = "absolute"
                steps = [
                  { color = "green", value = null },
                  { color = "red", value = 1 }
                ]
              }
            })
          }
          targets = [{
            expr         = "SortedOracles_isOldestReportExpired_isExpired{chain=\"${chain}\"}"
            legendFormat = "{{rateFeed}}"
          }]
        })
      ]
    ]),
    [
      for i, chain in keys(local.chains) : merge(local.common_panel_config, {
        id          = local.oracle_relayer_id_start + 1 + length(local.celo_chains) + i
        type        = "timeseries"
        title       = "${local.chains[chain].symbol} Balances of Relayer Signers [${local.chains[chain].title}]"
        description = "${local.chains[chain].symbol} balance of relayer signers on ${chain}. Red line indicates danger threshold."
        # Two panels per row; new row every 2 chains.
        gridPos = {
          x = (i % 2) * 12,
          y = local.oracle_relayer_y_start + 21 + floor(i / 2) * 8,
          h = 8,
          w = 12
        }
        fieldConfig = {
          defaults = {
            custom = {
              drawStyle         = "line"
              lineInterpolation = "linear"
              fillOpacity       = 10
              gradientMode      = "none"
              spanNulls         = false
              showPoints        = "auto"
              pointSize         = 5
              stacking = {
                mode  = "none"
                group = "A"
              }
              axisPlacement = "auto"
              axisLabel     = "${local.chains[chain].symbol} Balance"
              axisColorMode = "text"
              scaleDistribution = {
                type = "linear"
              }
              axisCenteredZero = false
              hideFrom = {
                tooltip = false
                viz     = false
                legend  = false
              }
              # This will draw the threshold as a line
              thresholdsStyle = {
                mode = "line"
              }
            }
            color    = { mode = "palette-classic" }
            mappings = []
            thresholds = {
              mode = "absolute"
              steps = [
                { color = "green", value = null },
                { color = "red", value = local.chains[chain].threshold }
              ]
            }
            unit = "locale"
            min  = 0 # Set the minimum value of the y-axis to 0 so the threshold line is always visible
          }
        }
        options = {
          tooltip = { mode = "multi" }
          legend = {
            showLegend  = true
            displayMode = "table"
            placement   = "bottom"
            calcs       = ["lastNotNull"]
          }
        }
        targets = [{
          expr         = "${local.chains[chain].metric}{chain=\"${chain}\", owner!=\"Reserve\"}"
          legendFormat = "{{owner}}" # This line is updated to use the 'owner' label
          refId        = chain
        }]
      })
    ]
  )
}
