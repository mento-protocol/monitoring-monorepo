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
  peg_policy_bundle           = jsondecode(file("${path.module}/peg-thresholds.json"))
  peg_active_policy           = local.peg_policy_bundle.active
  peg_previous_policy         = local.peg_policy_bundle.previous
  peg_active_policy_version   = local.peg_active_policy.version
  peg_previous_policy_version = try(local.peg_previous_policy.version, "no-retained-previous-policy")

  peg_active_assets   = local.peg_active_policy.assets
  peg_previous_assets = local.peg_previous_policy == null ? {} : local.peg_previous_policy.assets

  peg_active_sources = {
    for item in flatten([
      for asset_id, asset in local.peg_active_assets : [
        for source_id, source in asset.sources : {
          asset_id    = asset_id
          asset       = asset
          source_id   = source_id
          source      = source
          policy      = local.peg_active_policy
          policy_slot = "active"
        }
      ]
    ]) : "${item.asset_id}/${item.source_id}" => item
  }
  peg_active_authoritative_sources = {
    for key, item in local.peg_active_sources : key => item
    if item.source.authority != "display"
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
          asset_id    = asset_id
          asset       = asset
          source_id   = source_id
          source      = source
          policy      = local.peg_previous_policy
          policy_slot = "previous"
        }
      ]
    ]) : "${item.asset_id}/${item.source_id}" => item
  }
  peg_previous_authoritative_sources = {
    for key, item in local.peg_previous_sources : key => item
    if item.source.authority != "display"
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
