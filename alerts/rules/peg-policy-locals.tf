# Peg rules are generated from the gated policy artifact. Every PromQL selector
# names exactly one policy version; active and retained-previous expressions are
# deliberately separate so a rollover cannot mix samples across semantics.
#
# Deviation dwell uses a quantile over the policy window. Two independent
# coverage predicates make that duration claim honest: producer-side successful
# polls and producer-side usable uncapped decisions must both meet the approved
# cadence. The second counter is required because a capped observation advances
# poll_success while intentionally omitting deviation_bps.

locals {
  # This source-controlled switch is the only production activation boundary
  # for Peg Grafana consumers. This reviewed source change enables it; the
  # runbook's producer preconditions still gate the protected apply.
  peg_alerts_enabled = true
  peg_alert_instances = local.peg_alerts_enabled ? {
    "peg-monitoring" = true
  } : {}

  peg_policy_bundle           = jsondecode(file("${path.module}/peg-thresholds.json"))
  peg_active_policy           = local.peg_policy_bundle.active
  peg_previous_policy         = local.peg_policy_bundle.previous
  peg_active_policy_version   = local.peg_active_policy.version
  peg_previous_policy_version = try(local.peg_previous_policy.version, "no-retained-previous-policy")

  peg_secondary_source_unhealthy_for_duration = "1800s"

  peg_active_assets   = local.peg_active_policy.assets
  peg_previous_assets = local.peg_previous_policy == null ? {} : local.peg_previous_policy.assets

  peg_active_sources = {
    for item in flatten([
      for asset_id, asset in local.peg_active_assets : [
        for source_id, source in asset.sources : {
          asset_id                          = asset_id
          asset                             = asset
          source_id                         = source_id
          source                            = source
          policy                            = local.peg_active_policy
          policy_slot                       = "active"
          listing_absent_consecutive_checks = source.listingAbsentConsecutiveChecks
        }
      ]
    ]) : "${item.asset_id}/${item.source_id}" => item
  }
  peg_active_authoritative_sources = {
    for key, item in local.peg_active_sources : key => item
    if item.source.authority != "display"
  }
  # Display-only sources remain visible in market context and registry-rot
  # coverage, but do not create operational health alerts.
  peg_active_operational_sources = {
    for key, item in local.peg_active_sources : key => item
    if item.source.authority != "display"
  }
  peg_active_secondary_sources = {
    for key, item in local.peg_active_sources : key => item
    if item.source.authority == "secondary"
  }
  peg_active_source_unhealthy_for_duration = {
    for key, item in local.peg_active_operational_sources : key => (
      item.source.authority == "secondary" ? local.peg_secondary_source_unhealthy_for_duration : "${item.source.pollIntervalSeconds * 2}s"
    )
  }
  peg_active_deep_sources = {
    for key, item in local.peg_active_sources : key => item
    if item.source_id == item.asset.deepVenueSource
  }
  peg_active_non_deep_sources = {
    for key, item in local.peg_active_sources : key => item
    if item.source_id != item.asset.deepVenueSource
  }

  peg_previous_sources = {
    for item in flatten([
      for asset_id, asset in local.peg_previous_assets : [
        for source_id, source in asset.sources : {
          asset_id                          = asset_id
          asset                             = asset
          source_id                         = source_id
          source                            = source
          policy                            = local.peg_previous_policy
          policy_slot                       = "previous"
          listing_absent_consecutive_checks = source.listingAbsentConsecutiveChecks
        }
      ]
    ]) : "${item.asset_id}/${item.source_id}" => item
  }
  peg_previous_authoritative_sources = {
    for key, item in local.peg_previous_sources : key => item
    if item.source.authority != "display"
  }
  peg_previous_operational_sources = {
    for key, item in local.peg_previous_sources : key => item
    if item.source.authority != "display"
  }
  peg_previous_secondary_sources = {
    for key, item in local.peg_previous_sources : key => item
    if item.source.authority == "secondary"
  }
  peg_previous_source_unhealthy_for_duration = {
    for key, item in local.peg_previous_operational_sources : key => (
      item.source.authority == "secondary" ? local.peg_secondary_source_unhealthy_for_duration : "${item.source.pollIntervalSeconds * 2}s"
    )
  }
  peg_previous_deep_sources = {
    for key, item in local.peg_previous_sources : key => item
    if item.source_id == item.asset.deepVenueSource
  }
  peg_previous_non_deep_sources = {
    for key, item in local.peg_previous_sources : key => item
    if item.source_id != item.asset.deepVenueSource
  }
}
