# Generated rule definitions bind policy data to routing and no-data behavior.
locals {
  peg_active_rule_definitions = merge(
    {
      for key, item in local.peg_active_authoritative_sources : "active-downside-${key}" => {
        name               = "Peg Downside Warning [${item.asset_id}/${item.source_id} · active]"
        expr               = local.peg_active_downside_warning_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "market"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_active_policy_version
        query_range        = item.asset.warnSustainSeconds
        price_expr         = local.peg_active_price_promql[key]
        fill_expr          = local.peg_active_fill_promql[key]
        structural_expr    = local.peg_active_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "Executable downside deviation is sustained above the warning threshold."
        action             = "Compare the deep and secondary books, then inspect pool-flow saturation before escalating."
        notification       = local.peg_notify_market_warning
      }
    },
    {
      for key, item in local.peg_active_authoritative_sources : "active-premium-${key}" => {
        name               = "Peg Premium Warning [${item.asset_id}/${item.source_id} · active]"
        expr               = local.peg_active_premium_warning_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "market"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_active_policy_version
        query_range        = item.asset.warnSustainSeconds
        price_expr         = local.peg_active_price_promql[key]
        fill_expr          = local.peg_active_fill_promql[key]
        structural_expr    = local.peg_active_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "Executable sell price is sustained above the premium warning threshold."
        action             = "Review reserve-side exposure; premium is warning-only and never pages the drain path."
        notification       = local.peg_notify_market_warning
      }
    },
    {
      for key, item in local.peg_active_deep_sources : "active-critical-${key}" => {
        name               = "Peg Deep-Venue Downside Critical [${item.asset_id} · active]"
        expr               = local.peg_active_critical_deviation_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "critical"
        route              = "page"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_active_policy_version
        query_range        = item.asset.criticalSustainSeconds
        price_expr         = local.peg_active_price_promql[key]
        fill_expr          = local.peg_active_fill_promql[key]
        spread_expr        = local.peg_active_spread_context_promql[key]
        structural_expr    = local.peg_active_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_active_corroboration_promql[item.asset_id]
        summary            = "The policy-designated deep venue has a sustained executable downside deviation."
        action             = "Verify the deep book and structural flow, then follow the breaker-multisig decision runbook."
        notification       = local.peg_notify_page
      }
    },
    {
      for key, item in local.peg_active_deep_sources : "active-spread-${key}" => {
        name               = "Peg Deep-Venue Spread Warning [${item.asset_id} · active]"
        expr               = local.peg_active_spread_warning_promql[key]
        for_duration       = "${item.asset.warnSustainSeconds}s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "market"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_active_policy_version
        query_range        = item.asset.warnSustainSeconds
        price_expr         = local.peg_active_price_promql[key]
        fill_expr          = local.peg_active_fill_promql[key]
        structural_expr    = local.peg_active_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The deep venue spread exceeds its approved envelope."
        action             = "Check whether the book is evacuating or merely widening within a transient venue event."
        notification       = local.peg_notify_market_warning
      }
    },
    {
      for asset_id, asset in local.peg_active_assets : "active-structural-${asset_id}" => {
        name               = "Peg Structural Saturation Warning [${asset_id} · active]"
        expr               = local.peg_active_structural_warning_promql[asset_id]
        for_duration       = "${asset.warnSustainSeconds}s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "market"
        asset              = asset_id
        source             = ""
        policy_version     = local.peg_active_policy_version
        query_range        = asset.warnSustainSeconds
        price_expr         = local.peg_active_price_promql["${asset_id}/${asset.deepVenueSource}"]
        fill_expr          = local.peg_active_fill_promql["${asset_id}/${asset.deepVenueSource}"]
        structural_expr    = local.peg_active_structural_context_promql[asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "Indexed-pool directional flow is near the enforced trading-limit rate."
        action             = "Inspect pool flow and counterparties; structural saturation alone never pages."
        notification       = local.peg_notify_market_warning
      }
    },
    {
      for asset_id, asset in local.peg_active_assets : "active-blind-${asset_id}" => {
        name               = "Peg Blind Warning [${asset_id} · active]"
        expr               = local.peg_active_blind_warning_promql[asset_id]
        for_duration       = "0s"
        no_data_state      = "Alerting"
        severity           = "warning"
        route              = "ops"
        asset              = asset_id
        source             = asset.deepVenueSource
        policy_version     = local.peg_active_policy_version
        query_range        = asset.freshnessGraceSeconds
        price_expr         = local.peg_active_price_promql["${asset_id}/${asset.deepVenueSource}"]
        fill_expr          = local.peg_active_fill_promql["${asset_id}/${asset.deepVenueSource}"]
        structural_expr    = local.peg_active_structural_context_promql[asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "No usable uncapped price exists on the policy-designated deep venue."
        action             = "Inspect book depth and venue health; the consecutive-poll duration is derived from policy cadence."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for asset_id, asset in local.peg_active_assets : "active-blind-stressed-${asset_id}" => {
        name               = "Peg Blind While Stressed Critical [${asset_id} · active]"
        expr               = local.peg_active_blind_stressed_promql[asset_id]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "critical"
        route              = "page"
        asset              = asset_id
        source             = asset.deepVenueSource
        policy_version     = local.peg_active_policy_version
        query_range        = asset.freshnessGraceSeconds
        price_expr         = local.peg_active_price_promql["${asset_id}/${asset.deepVenueSource}"]
        fill_expr          = local.peg_active_fill_promql["${asset_id}/${asset.deepVenueSource}"]
        spread_expr        = local.peg_active_spread_context_promql["${asset_id}/${asset.deepVenueSource}"]
        structural_expr    = local.peg_active_structural_context_promql[asset_id]
        corroboration_expr = local.peg_active_corroboration_promql[asset_id]
        summary            = "The deep venue is blind while an independent stress leg is active."
        action             = "Treat this as a page: verify partial-price shortfall, spread, and structural flow before breaker action."
        notification       = local.peg_notify_page
      }
    },
    {
      for key, item in local.peg_active_non_deep_sources : "active-registry-rot-${key}" => {
        name               = "Peg Registry Rot [${item.asset_id}/${item.source_id} · active]"
        expr               = local.peg_active_listing_absent_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_active_policy_version
        query_range        = item.source.staleAfterSeconds
        price_expr         = local.peg_active_price_promql[key]
        fill_expr          = local.peg_active_fill_promql[key]
        listing_age_expr   = local.peg_active_listing_age_promql[key]
        structural_expr    = local.peg_active_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The producer confirms that this non-deep policy source's exact pair is absent."
        action             = "Verify the provider listing, then replace or remove the source through reviewed registry and policy cleanup."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_active_deep_sources : "active-critical-path-unreachable-${key}" => {
        name               = "Peg Critical Path Unreachable [${item.asset_id} · active]"
        expr               = local.peg_active_listing_absent_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_active_policy_version
        query_range        = item.source.staleAfterSeconds
        price_expr         = local.peg_active_price_promql[key]
        fill_expr          = local.peg_active_fill_promql[key]
        listing_age_expr   = local.peg_active_listing_age_promql[key]
        structural_expr    = local.peg_active_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The producer confirms that the policy-designated deep pair is absent."
        action             = "Treat the critical path as unreachable and re-onboard a replacement deep source through reviewed policy."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for asset_id, asset in local.peg_active_assets : "active-indexed-pool-unreachable-${asset_id}" => {
        name               = "Peg Indexed Pool Unreachable [${asset_id} · active]"
        expr               = local.peg_active_indexed_pool_unreachable_promql[asset_id]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = asset_id
        source             = ""
        policy_version     = local.peg_active_policy_version
        query_range        = asset.freshnessGraceSeconds
        price_expr         = local.peg_empty_context_promql
        fill_expr          = local.peg_empty_context_promql
        structural_expr    = local.peg_active_structural_context_promql[asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The registry-bound indexed pool is unreachable while the exact-version peg loop remains fresh."
        action             = "Inspect Hasura pool resolution and indexer coverage; use the heartbeat alert for a complete loop outage."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_active_sources : "active-unhealthy-${key}" => {
        name               = "Peg Source Unhealthy [${item.asset_id}/${item.source_id} · active]"
        expr               = local.peg_active_source_unhealthy_promql[key]
        for_duration       = "${item.source.pollIntervalSeconds * 2}s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_active_policy_version
        query_range        = item.asset.freshnessGraceSeconds
        price_expr         = local.peg_active_price_promql[key]
        fill_expr          = local.peg_active_fill_promql[key]
        structural_expr    = local.peg_active_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "A peg venue adapter is unhealthy while the isolated peg loop remains live."
        action             = "Inspect bounded peg error channels and venue/API status; this ops signal never pages."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_active_non_deep_sources : "active-dead-${key}" => {
        name               = "Peg Source Permanently Dead [${item.asset_id}/${item.source_id} · active]"
        expr               = local.peg_active_source_unhealthy_promql[key]
        for_duration       = "${item.asset.permanentlyDeadSeconds}s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_active_policy_version
        query_range        = item.asset.freshnessGraceSeconds
        price_expr         = local.peg_active_price_promql[key]
        fill_expr          = local.peg_active_fill_promql[key]
        structural_expr    = local.peg_active_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "A non-primary peg source has remained unhealthy for the policy dead-source interval."
        action             = "Re-census the venue and prepare a source-controlled registry/policy cleanup if the listing is gone."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for asset_id, asset in local.peg_active_assets : "active-heartbeat-${asset_id}" => {
        name               = "Peg Heartbeat Missing [${asset_id} · active]"
        expr               = local.peg_active_heartbeat_promql[asset_id]
        for_duration       = "0s"
        no_data_state      = "Alerting"
        severity           = "warning"
        route              = "ops"
        asset              = asset_id
        source             = ""
        policy_version     = local.peg_active_policy_version
        query_range        = asset.freshnessGraceSeconds
        price_expr         = local.peg_empty_context_promql
        fill_expr          = local.peg_empty_context_promql
        structural_expr    = local.peg_active_structural_context_promql[asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The isolated peg loop has not completed an asset poll within the freshness grace."
        action             = "Check metrics-bridge peg-loop logs and policy fetch health before trusting market decisions."
        notification       = local.peg_notify_ops_warning
      }
    },
  )

  # The retained-previous packet intentionally mirrors the decision ladder. It
  # is empty when previous=null and has no active-ACK exclusion when populated.
  peg_previous_rule_definitions = merge(
    {
      for key, item in local.peg_previous_authoritative_sources : "previous-downside-${key}" => {
        name               = "Peg Downside Warning [${item.asset_id}/${item.source_id} · previous]"
        expr               = local.peg_previous_downside_warning_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "market"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_previous_policy_version
        query_range        = item.asset.warnSustainSeconds
        price_expr         = local.peg_previous_price_promql[key]
        fill_expr          = local.peg_previous_fill_promql[key]
        structural_expr    = local.peg_previous_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "Retained-policy executable downside deviation remains above warning."
        action             = "Evaluate this policy version independently; remove retained rules only through the reviewed JSON cleanup."
        notification       = local.peg_notify_market_warning
      }
    },
    {
      for key, item in local.peg_previous_authoritative_sources : "previous-premium-${key}" => {
        name               = "Peg Premium Warning [${item.asset_id}/${item.source_id} · previous]"
        expr               = local.peg_previous_premium_warning_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "market"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_previous_policy_version
        query_range        = item.asset.warnSustainSeconds
        price_expr         = local.peg_previous_price_promql[key]
        fill_expr          = local.peg_previous_fill_promql[key]
        structural_expr    = local.peg_previous_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "Retained-policy executable premium remains above warning."
        action             = "Review reserve-side exposure under the retained policy."
        notification       = local.peg_notify_market_warning
      }
    },
    {
      for key, item in local.peg_previous_deep_sources : "previous-critical-${key}" => {
        name               = "Peg Deep-Venue Downside Critical [${item.asset_id} · previous]"
        expr               = local.peg_previous_critical_deviation_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "critical"
        route              = "page"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_previous_policy_version
        query_range        = item.asset.criticalSustainSeconds
        price_expr         = local.peg_previous_price_promql[key]
        fill_expr          = local.peg_previous_fill_promql[key]
        spread_expr        = local.peg_previous_spread_context_promql[key]
        structural_expr    = local.peg_previous_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_previous_corroboration_promql[item.asset_id]
        summary            = "The retained policy's deep venue has a sustained critical downside deviation."
        action             = "Treat this version independently until source-controlled cleanup removes it."
        notification       = local.peg_notify_page
      }
    },
    {
      for key, item in local.peg_previous_deep_sources : "previous-spread-${key}" => {
        name               = "Peg Deep-Venue Spread Warning [${item.asset_id} · previous]"
        expr               = local.peg_previous_spread_warning_promql[key]
        for_duration       = "${item.asset.warnSustainSeconds}s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "market"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_previous_policy_version
        query_range        = item.asset.warnSustainSeconds
        price_expr         = local.peg_previous_price_promql[key]
        fill_expr          = local.peg_previous_fill_promql[key]
        structural_expr    = local.peg_previous_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The retained policy's deep-venue spread exceeds its envelope."
        action             = "Inspect the retained policy's venue state."
        notification       = local.peg_notify_market_warning
      }
    },
    {
      for asset_id, asset in local.peg_previous_assets : "previous-structural-${asset_id}" => {
        name               = "Peg Structural Saturation Warning [${asset_id} · previous]"
        expr               = local.peg_previous_structural_warning_promql[asset_id]
        for_duration       = "${asset.warnSustainSeconds}s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "market"
        asset              = asset_id
        source             = ""
        policy_version     = local.peg_previous_policy_version
        query_range        = asset.warnSustainSeconds
        price_expr         = local.peg_previous_price_promql["${asset_id}/${asset.deepVenueSource}"]
        fill_expr          = local.peg_previous_fill_promql["${asset_id}/${asset.deepVenueSource}"]
        structural_expr    = local.peg_previous_structural_context_promql[asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "Retained-policy structural saturation remains elevated."
        action             = "Inspect pool flow under the retained policy."
        notification       = local.peg_notify_market_warning
      }
    },
    {
      for asset_id, asset in local.peg_previous_assets : "previous-blind-${asset_id}" => {
        name               = "Peg Blind Warning [${asset_id} · previous]"
        expr               = local.peg_previous_blind_warning_promql[asset_id]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = asset_id
        source             = asset.deepVenueSource
        policy_version     = local.peg_previous_policy_version
        query_range        = asset.freshnessGraceSeconds
        price_expr         = local.peg_previous_price_promql["${asset_id}/${asset.deepVenueSource}"]
        fill_expr          = local.peg_previous_fill_promql["${asset_id}/${asset.deepVenueSource}"]
        structural_expr    = local.peg_previous_structural_context_promql[asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The retained policy has no usable deep-venue price."
        action             = "Inspect retained-policy venue health; do not gate this rule on the active ACK."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for asset_id, asset in local.peg_previous_assets : "previous-blind-stressed-${asset_id}" => {
        name               = "Peg Blind While Stressed Critical [${asset_id} · previous]"
        expr               = local.peg_previous_blind_stressed_promql[asset_id]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "critical"
        route              = "page"
        asset              = asset_id
        source             = asset.deepVenueSource
        policy_version     = local.peg_previous_policy_version
        query_range        = asset.freshnessGraceSeconds
        price_expr         = local.peg_previous_price_promql["${asset_id}/${asset.deepVenueSource}"]
        fill_expr          = local.peg_previous_fill_promql["${asset_id}/${asset.deepVenueSource}"]
        spread_expr        = local.peg_previous_spread_context_promql["${asset_id}/${asset.deepVenueSource}"]
        structural_expr    = local.peg_previous_structural_context_promql[asset_id]
        corroboration_expr = local.peg_previous_corroboration_promql[asset_id]
        summary            = "The retained policy is blind while an independent stress leg is active."
        action             = "Verify partial-price shortfall, spread, and structural flow before breaker action."
        notification       = local.peg_notify_page
      }
    },
    {
      for key, item in local.peg_previous_non_deep_sources : "previous-registry-rot-${key}" => {
        name               = "Peg Registry Rot [${item.asset_id}/${item.source_id} · previous]"
        expr               = local.peg_previous_listing_absent_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_previous_policy_version
        query_range        = item.source.staleAfterSeconds
        price_expr         = local.peg_previous_price_promql[key]
        fill_expr          = local.peg_previous_fill_promql[key]
        listing_age_expr   = local.peg_previous_listing_age_promql[key]
        structural_expr    = local.peg_previous_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The producer confirms that this retained non-deep policy source's exact pair is absent."
        action             = "Verify the retained version independently; remove or replace its source only through reviewed cleanup."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_previous_deep_sources : "previous-critical-path-unreachable-${key}" => {
        name               = "Peg Critical Path Unreachable [${item.asset_id} · previous]"
        expr               = local.peg_previous_listing_absent_promql[key]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_previous_policy_version
        query_range        = item.source.staleAfterSeconds
        price_expr         = local.peg_previous_price_promql[key]
        fill_expr          = local.peg_previous_fill_promql[key]
        listing_age_expr   = local.peg_previous_listing_age_promql[key]
        structural_expr    = local.peg_previous_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The producer confirms that the retained policy's deep pair is absent."
        action             = "Treat this retained critical path as unreachable until reviewed policy cleanup removes or replaces it."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for asset_id, asset in local.peg_previous_assets : "previous-indexed-pool-unreachable-${asset_id}" => {
        name               = "Peg Indexed Pool Unreachable [${asset_id} · previous]"
        expr               = local.peg_previous_indexed_pool_unreachable_promql[asset_id]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = asset_id
        source             = ""
        policy_version     = local.peg_previous_policy_version
        query_range        = asset.freshnessGraceSeconds
        price_expr         = local.peg_empty_context_promql
        fill_expr          = local.peg_empty_context_promql
        structural_expr    = local.peg_previous_structural_context_promql[asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The retained policy's registry-bound indexed pool is unreachable while its peg loop remains fresh."
        action             = "Inspect Hasura pool resolution and retain this rule until reviewed policy cleanup removes the version."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_previous_sources : "previous-unhealthy-${key}" => {
        name               = "Peg Source Unhealthy [${item.asset_id}/${item.source_id} · previous]"
        expr               = local.peg_previous_source_unhealthy_promql[key]
        for_duration       = "${item.source.pollIntervalSeconds * 2}s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_previous_policy_version
        query_range        = item.asset.freshnessGraceSeconds
        price_expr         = local.peg_previous_price_promql[key]
        fill_expr          = local.peg_previous_fill_promql[key]
        structural_expr    = local.peg_previous_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "A retained-policy source is unhealthy."
        action             = "Inspect the retained policy's venue/API path."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_previous_non_deep_sources : "previous-dead-${key}" => {
        name               = "Peg Source Permanently Dead [${item.asset_id}/${item.source_id} · previous]"
        expr               = local.peg_previous_source_unhealthy_promql[key]
        for_duration       = "${item.asset.permanentlyDeadSeconds}s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = item.asset_id
        source             = item.source_id
        policy_version     = local.peg_previous_policy_version
        query_range        = item.asset.freshnessGraceSeconds
        price_expr         = local.peg_previous_price_promql[key]
        fill_expr          = local.peg_previous_fill_promql[key]
        structural_expr    = local.peg_previous_structural_context_promql[item.asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "A retained-policy non-primary source is permanently dead."
        action             = "Remove it only through reviewed retained-policy cleanup."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for asset_id, asset in local.peg_previous_assets : "previous-heartbeat-${asset_id}" => {
        name               = "Peg Heartbeat Missing [${asset_id} · previous]"
        expr               = local.peg_previous_heartbeat_promql[asset_id]
        for_duration       = "0s"
        no_data_state      = "OK"
        severity           = "warning"
        route              = "ops"
        asset              = asset_id
        source             = ""
        policy_version     = local.peg_previous_policy_version
        query_range        = asset.freshnessGraceSeconds
        price_expr         = local.peg_empty_context_promql
        fill_expr          = local.peg_empty_context_promql
        structural_expr    = local.peg_previous_structural_context_promql[asset_id]
        corroboration_expr = local.peg_no_corroboration_promql
        summary            = "The retained policy has no fresh peg-loop heartbeat."
        action             = "Keep retained rules live until explicit source-controlled cleanup."
        notification       = local.peg_notify_ops_warning
      }
    },
  )

  peg_rollover_rule_definitions = local.peg_previous_policy == null ? {} : {
    active-policy-ack = {
      name               = "Peg Policy Rollover Stuck"
      expr               = local.peg_rollover_ack_stuck_promql
      for_duration       = "${local.peg_active_policy.rolloverAckExpectedSeconds}s"
      no_data_state      = "OK"
      severity           = "warning"
      route              = "ops"
      asset              = "policy"
      source             = ""
      policy_version     = local.peg_active_policy_version
      query_range        = local.peg_active_policy.rolloverAckExpectedSeconds
      price_expr         = local.peg_empty_context_promql
      fill_expr          = local.peg_empty_context_promql
      structural_expr    = local.peg_empty_context_promql
      corroboration_expr = local.peg_no_corroboration_promql
      summary            = "The producer has not acknowledged the active gated peg policy within its expected window."
      action             = "Check private policy fetch/auth and bridge peg-loop logs; do not remove the retained policy."
      notification       = local.peg_notify_ops_warning
    }
  }

  peg_rule_definitions = merge(
    local.peg_active_rule_definitions,
    local.peg_previous_rule_definitions,
    local.peg_rollover_rule_definitions,
  )
}
