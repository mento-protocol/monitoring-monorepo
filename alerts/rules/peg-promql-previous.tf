# Retained-previous PromQL remains source-controlled and dormant when previous=null.
locals {
  # Previous expressions stay source-controlled and continue evaluating until
  # the retained previous policy is explicitly removed from the JSON. They are
  # never suppressed by the first active-policy ACK.
  peg_previous_downside_warning_promql = {
    for key, item in local.peg_previous_authoritative_sources : key => format(
      "quantile_over_time(%g, mento_peg_deviation_bps{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) increase(mento_peg_poll_success_total{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) increase(mento_peg_usable_decision_total{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) mento_peg_source_healthy{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,source,policy_version) (time() - mento_peg_observation_at{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)",
      item.asset.durationQuantile,
      item.asset_id,
      item.source_id,
      item.asset.warnSustainSeconds,
      item.asset.warnDeviationBps + item.source.conversionErrorBps,
      item.asset_id,
      item.source_id,
      item.asset.warnSustainSeconds,
      ceil(item.asset.warnSustainSeconds / item.source.pollIntervalSeconds * item.asset.minimumCoverageFraction),
      item.asset_id,
      item.source_id,
      item.asset.warnSustainSeconds,
      ceil(item.asset.warnSustainSeconds / item.source.pollIntervalSeconds * item.asset.minimumCoverageFraction),
      item.asset_id,
      item.source_id,
      item.asset_id,
      item.source_id,
      item.source.staleAfterSeconds,
    )
  }
  peg_previous_critical_deviation_promql = {
    for key, item in local.peg_previous_deep_sources : key => format(
      "quantile_over_time(%g, mento_peg_deviation_bps{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) increase(mento_peg_poll_success_total{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) increase(mento_peg_usable_decision_total{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) mento_peg_source_healthy{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,source,policy_version) (time() - mento_peg_observation_at{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)",
      item.asset.durationQuantile,
      item.asset_id,
      item.source_id,
      item.asset.criticalSustainSeconds,
      item.asset.criticalDeviationBps + item.source.conversionErrorBps,
      item.asset_id,
      item.source_id,
      item.asset.criticalSustainSeconds,
      ceil(item.asset.criticalSustainSeconds / item.source.pollIntervalSeconds * item.asset.minimumCoverageFraction),
      item.asset_id,
      item.source_id,
      item.asset.criticalSustainSeconds,
      ceil(item.asset.criticalSustainSeconds / item.source.pollIntervalSeconds * item.asset.minimumCoverageFraction),
      item.asset_id,
      item.source_id,
      item.asset_id,
      item.source_id,
      item.source.staleAfterSeconds,
    )
  }
  peg_previous_premium_warning_promql = {
    for key, item in local.peg_previous_authoritative_sources : key => format(
      "quantile_over_time(%g, mento_peg_premium_bps{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) increase(mento_peg_poll_success_total{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) increase(mento_peg_usable_decision_total{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) >= %g and on(asset,source,policy_version) mento_peg_source_healthy{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,source,policy_version) (time() - mento_peg_observation_at{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)",
      item.asset.durationQuantile,
      item.asset_id,
      item.source_id,
      item.asset.warnSustainSeconds,
      item.asset.premiumWarnBps + item.source.conversionErrorBps,
      item.asset_id,
      item.source_id,
      item.asset.warnSustainSeconds,
      ceil(item.asset.warnSustainSeconds / item.source.pollIntervalSeconds * item.asset.minimumCoverageFraction),
      item.asset_id,
      item.source_id,
      item.asset.warnSustainSeconds,
      ceil(item.asset.warnSustainSeconds / item.source.pollIntervalSeconds * item.asset.minimumCoverageFraction),
      item.asset_id,
      item.source_id,
      item.asset_id,
      item.source_id,
      item.source.staleAfterSeconds,
    )
  }
  peg_previous_spread_warning_promql = {
    for key, item in local.peg_previous_deep_sources : key => format(
      "mento_peg_spread_bps{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} > %g and on(asset,source,policy_version) mento_peg_source_healthy{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,source,policy_version) (time() - mento_peg_observation_at{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)",
      item.asset_id,
      item.source_id,
      item.source.spreadEnvelopeBps,
      item.asset_id,
      item.source_id,
      item.asset_id,
      item.source_id,
      item.source.staleAfterSeconds,
    )
  }
  peg_previous_structural_warning_promql = {
    for asset_id, asset in local.peg_previous_assets : asset_id => format(
      "mento_peg_structural_saturation{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} >= %g and on(asset,policy_version) mento_peg_indexed_pool_reachable{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)",
      asset_id,
      asset.structuralWarnFraction,
      asset_id,
      asset_id,
      asset.freshnessGraceSeconds,
    )
  }
  peg_previous_blind_warning_promql = {
    for asset_id, asset in local.peg_previous_assets : asset_id => format(
      "(mento_peg_blind{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == bool 1) * on(asset,policy_version) ((time() - mento_peg_last_poll{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}) <= bool %d)",
      asset_id,
      asset_id,
      asset.freshnessGraceSeconds,
    )
  }
  peg_previous_blind_stressed_promql = {
    for asset_id, asset in local.peg_previous_assets : asset_id => format(
      "mento_peg_blind{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d) and on(asset,policy_version) ((mento_peg_structural_saturation{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} >= %g and on(asset,policy_version) mento_peg_indexed_pool_reachable{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1) or (mento_peg_spread_bps{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} > %g and on(asset,source,policy_version) (time() - mento_peg_observation_at{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)) or (mento_peg_capped{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,source,policy_version) ((%g - mento_peg_executable_px{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}) / %g * 10000 >= %g) and on(asset,source,policy_version) (time() - mento_peg_observation_at{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)))",
      asset_id,
      asset_id,
      asset.freshnessGraceSeconds,
      asset_id,
      asset.structuralWarnFraction,
      asset_id,
      asset_id,
      asset.deepVenueSource,
      asset.sources[asset.deepVenueSource].spreadEnvelopeBps,
      asset_id,
      asset.deepVenueSource,
      asset.sources[asset.deepVenueSource].staleAfterSeconds,
      asset_id,
      asset.deepVenueSource,
      asset.target,
      asset_id,
      asset.deepVenueSource,
      asset.target,
      asset.criticalDeviationBps + asset.sources[asset.deepVenueSource].conversionErrorBps,
      asset_id,
      asset.deepVenueSource,
      asset.sources[asset.deepVenueSource].staleAfterSeconds,
    )
  }
  peg_previous_source_unhealthy_promql = {
    for key, item in local.peg_previous_sources : key => format(
      "mento_peg_source_healthy{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == bool 0 and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)",
      item.asset_id,
      item.source_id,
      item.asset_id,
      item.asset.freshnessGraceSeconds,
    )
  }
  peg_previous_heartbeat_promql = {
    for asset_id, asset in local.peg_previous_assets : asset_id => format(
      "(time() - max_over_time(mento_peg_last_poll{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds]) > bool %d) or absent_over_time(mento_peg_last_poll{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"}[%ds])",
      asset_id,
      asset.freshnessGraceSeconds,
      asset.freshnessGraceSeconds,
      asset_id,
      asset.freshnessGraceSeconds,
    )
  }
  peg_previous_price_promql = {
    for key, item in local.peg_previous_sources : key => format(
      "mento_peg_executable_px{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} or on() vector(-1)",
      item.asset_id,
      item.source_id,
    )
  }
  peg_previous_fill_promql = {
    for key, item in local.peg_previous_sources : key => format(
      "mento_peg_filled_fraction{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} * 100 or on() vector(-1)",
      item.asset_id,
      item.source_id,
    )
  }
  peg_previous_spread_context_promql = {
    for key, item in local.peg_previous_sources : key => format(
      "mento_peg_spread_bps{asset=\"%s\",source=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} or on() vector(-1)",
      item.asset_id,
      item.source_id,
    )
  }
  peg_previous_structural_context_promql = {
    for asset_id, asset in local.peg_previous_assets : asset_id => format(
      "mento_peg_structural_saturation{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} * 100 or on() vector(-1)",
      asset_id,
    )
  }
  peg_previous_corroboration_promql = {
    for asset_id, asset in local.peg_previous_assets : asset_id => format(
      "max((mento_peg_structural_saturation{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} >= %g and on(asset,policy_version) mento_peg_indexed_pool_reachable{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,policy_version) (time() - mento_peg_last_poll{asset=\"%s\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d)) or max by(asset,policy_version) (mento_peg_deviation_bps{asset=\"%s\",source=~\"^(?:%s)$\",policy_version=\"${local.peg_previous_policy_version}\"} >= %g and on(asset,source,policy_version) mento_peg_source_healthy{asset=\"%s\",source=~\"^(?:%s)$\",policy_version=\"${local.peg_previous_policy_version}\"} == 1 and on(asset,source,policy_version) (time() - mento_peg_observation_at{asset=\"%s\",source=~\"^(?:%s)$\",policy_version=\"${local.peg_previous_policy_version}\"} <= %d))) or on() vector(0)",
      asset_id,
      asset.structuralWarnFraction,
      asset_id,
      asset_id,
      asset.freshnessGraceSeconds,
      asset_id,
      join("|", [for source_id, source in asset.sources : source_id if source.authority == "secondary"]),
      asset.criticalDeviationBps + max(concat([0], [for source in values(asset.sources) : source.conversionErrorBps if source.authority == "secondary"])...),
      asset_id,
      join("|", [for source_id, source in asset.sources : source_id if source.authority == "secondary"]),
      asset_id,
      join("|", [for source_id, source in asset.sources : source_id if source.authority == "secondary"]),
      min(concat([asset.freshnessGraceSeconds], [for source in values(asset.sources) : source.staleAfterSeconds if source.authority == "secondary"])...),
    )
  }

  peg_rollover_ack_stuck_promql = format(
    "absent(mento_peg_policy_version{policy_version=\"${local.peg_active_policy_version}\"})",
  )

  peg_empty_context_promql    = "vector(-1)"
  peg_no_corroboration_promql = "vector(0)"
}
