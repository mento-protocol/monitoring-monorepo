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
        summary            = "${local.peg_source_display_names[key]} sell price is {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}below peg"
        resolved_summary   = "${local.peg_source_display_names[key]} sell price was {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}below peg"
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
        summary            = "${local.peg_source_display_names[key]} sell price is {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}above peg"
        resolved_summary   = "${local.peg_source_display_names[key]} sell price was {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}above peg"
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
        summary            = "${local.peg_source_display_names[key]} sell price is {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}below peg"
        resolved_summary   = "${local.peg_source_display_names[key]} sell price was {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}below peg"
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
        summary            = "${local.peg_source_display_names[key]} buy and sell prices are {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ else }}unusually far {{ end }}apart"
        resolved_summary   = "${local.peg_source_display_names[key]} buy and sell prices were {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ else }}unusually far {{ end }}apart"
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
        summary            = "${local.peg_asset_display_names[asset_id]} pool flow {{ if $values.Structural }}is using {{ printf \"%.4g\" $values.Structural.Value }}% of its trading limit{{ else }}is close to its trading limit{{ end }}"
        resolved_summary   = "${local.peg_asset_display_names[asset_id]} pool flow {{ if $values.Structural }}used {{ printf \"%.4g\" $values.Structural.Value }}% of its trading limit{{ else }}was close to its trading limit{{ end }}"
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
        summary            = local.peg_active_source_failure_summaries["${asset_id}/${asset.deepVenueSource}"]
        resolved_summary   = local.peg_active_source_failure_resolved_summaries["${asset_id}/${asset.deepVenueSource}"]
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
        summary            = "${local.peg_active_source_failure_summaries["${asset_id}/${asset.deepVenueSource}"]} while separate market data also shows stress"
        resolved_summary   = "${local.peg_active_source_failure_resolved_summaries["${asset_id}/${asset.deepVenueSource}"]} while separate market data also showed stress"
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
        summary            = "${local.peg_source_display_names[key]} does not list the ${local.peg_asset_display_names[item.asset_id]}/${upper(split("_", item.source_id)[1])} market"
        resolved_summary   = "${local.peg_source_display_names[key]} did not list the ${local.peg_asset_display_names[item.asset_id]}/${upper(split("_", item.source_id)[1])} market"
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
        summary            = "${local.peg_source_display_names[key]} does not list the ${local.peg_asset_display_names[item.asset_id]}/${upper(split("_", item.source_id)[1])} market"
        resolved_summary   = "${local.peg_source_display_names[key]} did not list the ${local.peg_asset_display_names[item.asset_id]}/${upper(split("_", item.source_id)[1])} market"
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
        summary            = replace(local.peg_indexed_pool_summary_template, "__ASSET__", local.peg_asset_display_names[asset_id])
        resolved_summary   = replace(local.peg_indexed_pool_resolved_summary_template, "__ASSET__", local.peg_asset_display_names[asset_id])
        action             = "Inspect Hasura pool resolution and indexer coverage; use the heartbeat alert for a complete loop outage."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_active_operational_sources : "active-unhealthy-${key}" => {
        name               = "Peg Source Unhealthy [${item.asset_id}/${item.source_id} · active]"
        expr               = local.peg_active_source_unhealthy_promql[key]
        for_duration       = local.peg_active_source_unhealthy_for_duration[key]
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
        summary            = local.peg_active_source_failure_summaries[key]
        resolved_summary   = local.peg_active_source_failure_resolved_summaries[key]
        action             = "Inspect bounded peg error channels and venue/API status; this ops signal never pages."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_active_secondary_sources : "active-dead-${key}" => {
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
        summary            = local.peg_active_source_failure_summaries[key]
        resolved_summary   = local.peg_active_source_failure_resolved_summaries[key]
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
        summary            = "${local.peg_asset_display_names[asset_id]} monitor data has stopped updating"
        resolved_summary   = "${local.peg_asset_display_names[asset_id]} monitor data stopped updating"
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
        summary            = "${local.peg_source_display_names[key]} sell price is {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}below peg"
        resolved_summary   = "${local.peg_source_display_names[key]} sell price was {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}below peg"
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
        summary            = "${local.peg_source_display_names[key]} sell price is {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}above peg"
        resolved_summary   = "${local.peg_source_display_names[key]} sell price was {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}above peg"
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
        summary            = "${local.peg_source_display_names[key]} sell price is {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}below peg"
        resolved_summary   = "${local.peg_source_display_names[key]} sell price was {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ end }}below peg"
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
        summary            = "${local.peg_source_display_names[key]} buy and sell prices are {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ else }}unusually far {{ end }}apart"
        resolved_summary   = "${local.peg_source_display_names[key]} buy and sell prices were {{ if $values.A }}{{ printf \"%.4g\" $values.A.Value }} bps {{ else }}unusually far {{ end }}apart"
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
        summary            = "${local.peg_asset_display_names[asset_id]} pool flow {{ if $values.Structural }}is using {{ printf \"%.4g\" $values.Structural.Value }}% of its trading limit{{ else }}is close to its trading limit{{ end }}"
        resolved_summary   = "${local.peg_asset_display_names[asset_id]} pool flow {{ if $values.Structural }}used {{ printf \"%.4g\" $values.Structural.Value }}% of its trading limit{{ else }}was close to its trading limit{{ end }}"
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
        summary            = local.peg_previous_source_failure_summaries["${asset_id}/${asset.deepVenueSource}"]
        resolved_summary   = local.peg_previous_source_failure_resolved_summaries["${asset_id}/${asset.deepVenueSource}"]
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
        summary            = "${local.peg_previous_source_failure_summaries["${asset_id}/${asset.deepVenueSource}"]} while separate market data also shows stress"
        resolved_summary   = "${local.peg_previous_source_failure_resolved_summaries["${asset_id}/${asset.deepVenueSource}"]} while separate market data also showed stress"
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
        summary            = "${local.peg_source_display_names[key]} does not list the ${local.peg_asset_display_names[item.asset_id]}/${upper(split("_", item.source_id)[1])} market"
        resolved_summary   = "${local.peg_source_display_names[key]} did not list the ${local.peg_asset_display_names[item.asset_id]}/${upper(split("_", item.source_id)[1])} market"
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
        summary            = "${local.peg_source_display_names[key]} does not list the ${local.peg_asset_display_names[item.asset_id]}/${upper(split("_", item.source_id)[1])} market"
        resolved_summary   = "${local.peg_source_display_names[key]} did not list the ${local.peg_asset_display_names[item.asset_id]}/${upper(split("_", item.source_id)[1])} market"
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
        summary            = replace(local.peg_indexed_pool_summary_template, "__ASSET__", local.peg_asset_display_names[asset_id])
        resolved_summary   = replace(local.peg_indexed_pool_resolved_summary_template, "__ASSET__", local.peg_asset_display_names[asset_id])
        action             = "Inspect Hasura pool resolution and retain this rule until reviewed policy cleanup removes the version."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_previous_operational_sources : "previous-unhealthy-${key}" => {
        name               = "Peg Source Unhealthy [${item.asset_id}/${item.source_id} · previous]"
        expr               = local.peg_previous_source_unhealthy_promql[key]
        for_duration       = local.peg_previous_source_unhealthy_for_duration[key]
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
        summary            = local.peg_previous_source_failure_summaries[key]
        resolved_summary   = local.peg_previous_source_failure_resolved_summaries[key]
        action             = "Inspect the retained policy's venue/API path."
        notification       = local.peg_notify_ops_warning
      }
    },
    {
      for key, item in local.peg_previous_secondary_sources : "previous-dead-${key}" => {
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
        summary            = local.peg_previous_source_failure_summaries[key]
        resolved_summary   = local.peg_previous_source_failure_resolved_summaries[key]
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
        summary            = "${local.peg_asset_display_names[asset_id]} monitor data has stopped updating"
        resolved_summary   = "${local.peg_asset_display_names[asset_id]} monitor data stopped updating"
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
      summary            = "Peg monitor has not loaded policy ${local.peg_active_policy_version}"
      resolved_summary   = "Peg monitor did not load policy ${local.peg_active_policy_version}"
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
