# Peg alert summaries are user-facing copy. Rule names stay stable because
# Grafana uses them as alert identity, while summaries lead with the concrete
# cause shown in Grafana, Slack, and Splunk On-Call.
locals {
  peg_asset_symbol_display_names = {
    europ = "EUROP"
    kesm  = "KESm"
  }
  peg_provider_display_names = {
    bitvavo = "Bitvavo"
    kraken  = "Kraken"
    valr    = "VALR"
  }
  peg_asset_display_names = merge(
    {
      for asset_id in keys(local.peg_active_assets) : asset_id => lookup(
        local.peg_asset_symbol_display_names,
        split("-", asset_id)[0],
        upper(split("-", asset_id)[0]),
      )
    },
    {
      for asset_id in keys(local.peg_previous_assets) : asset_id => lookup(
        local.peg_asset_symbol_display_names,
        split("-", asset_id)[0],
        upper(split("-", asset_id)[0]),
      )
    },
  )
  peg_source_display_names = merge(
    {
      for key, item in local.peg_active_sources : key => lookup(
        local.peg_provider_display_names,
        split("_", item.source_id)[0],
        title(split("_", item.source_id)[0]),
      )
    },
    {
      for key, item in local.peg_previous_sources : key => lookup(
        local.peg_provider_display_names,
        split("_", item.source_id)[0],
        title(split("_", item.source_id)[0]),
      )
    },
  )

  peg_source_failure_summary_template = chomp(<<-EOT
{{ if eq (printf "%.0f" $values.Reason.Value) "1" }}__SOURCE__ is rejecting price requests because its rate limit is reached{{ if and $values.HttpStatus (gt $values.HttpStatus.Value 0.0) }} (HTTP {{ printf "%.0f" $values.HttpStatus.Value }}){{ end }}{{ else if eq (printf "%.0f" $values.Reason.Value) "2" }}__SOURCE__ price request returns {{ if and $values.HttpStatus (gt $values.HttpStatus.Value 0.0) }}HTTP {{ printf "%.0f" $values.HttpStatus.Value }}{{ else }}an HTTP error{{ end }}{{ else if eq (printf "%.0f" $values.Reason.Value) "3" }}__SOURCE__ price request is timing out{{ else if eq (printf "%.0f" $values.Reason.Value) "4" }}__SOURCE__ cannot be reached{{ else if eq (printf "%.0f" $values.Reason.Value) "5" }}__SOURCE__ is returning invalid price data{{ else if eq (printf "%.0f" $values.Reason.Value) "6" }}__SOURCE__ price data has stopped updating{{ else if eq (printf "%.0f" $values.Reason.Value) "7" }}__SOURCE__ is repeating old price data{{ else if eq (printf "%.0f" $values.Reason.Value) "8" }}__SOURCE__ cannot fill the monitored sell size{{ if and $values.Fill (ge $values.Fill.Value 0.0) }}; only {{ printf "%.4g" $values.Fill.Value }}% is available{{ end }}{{ else if eq (printf "%.0f" $values.Reason.Value) "9" }}__SOURCE__ market is halted{{ else if eq (printf "%.0f" $values.Reason.Value) "10" }}__SOURCE__ price cannot be converted to the peg currency{{ else if eq (printf "%.0f" $values.Reason.Value) "11" }}__SOURCE__ price conversion is failing{{ else if eq (printf "%.0f" $values.Reason.Value) "16" }}Pool data does not provide the monitored sell size{{ else if eq (printf "%.0f" $values.Reason.Value) "17" }}__SOURCE__ is not supported by the monitor{{ else if eq (printf "%.0f" $values.Reason.Value) "19" }}Multiple failures are preventing a usable __SOURCE__ price{{ else if eq (printf "%.0f" $values.Reason.Value) "20" }}__SOURCE__ does not list this market{{ else }}__SOURCE__ is not providing a usable sell price{{ end }}
EOT
  )

  peg_source_failure_resolved_summary_template = chomp(<<-EOT
{{ if eq (printf "%.0f" $values.Reason.Value) "1" }}__SOURCE__ rejected price requests because its rate limit was reached{{ if and $values.HttpStatus (gt $values.HttpStatus.Value 0.0) }} (HTTP {{ printf "%.0f" $values.HttpStatus.Value }}){{ end }}{{ else if eq (printf "%.0f" $values.Reason.Value) "2" }}__SOURCE__ price request returned {{ if and $values.HttpStatus (gt $values.HttpStatus.Value 0.0) }}HTTP {{ printf "%.0f" $values.HttpStatus.Value }}{{ else }}an HTTP error{{ end }}{{ else if eq (printf "%.0f" $values.Reason.Value) "3" }}__SOURCE__ price request timed out{{ else if eq (printf "%.0f" $values.Reason.Value) "4" }}__SOURCE__ could not be reached{{ else if eq (printf "%.0f" $values.Reason.Value) "5" }}__SOURCE__ returned invalid price data{{ else if eq (printf "%.0f" $values.Reason.Value) "6" }}__SOURCE__ price data stopped updating{{ else if eq (printf "%.0f" $values.Reason.Value) "7" }}__SOURCE__ repeated old price data{{ else if eq (printf "%.0f" $values.Reason.Value) "8" }}__SOURCE__ could not fill the monitored sell size{{ if and $values.Fill (ge $values.Fill.Value 0.0) }}; only {{ printf "%.4g" $values.Fill.Value }}% was available{{ end }}{{ else if eq (printf "%.0f" $values.Reason.Value) "9" }}__SOURCE__ market was halted{{ else if eq (printf "%.0f" $values.Reason.Value) "10" }}__SOURCE__ price could not be converted to the peg currency{{ else if eq (printf "%.0f" $values.Reason.Value) "11" }}__SOURCE__ price conversion failed{{ else if eq (printf "%.0f" $values.Reason.Value) "16" }}Pool data did not provide the monitored sell size{{ else if eq (printf "%.0f" $values.Reason.Value) "17" }}__SOURCE__ was not supported by the monitor{{ else if eq (printf "%.0f" $values.Reason.Value) "19" }}Multiple failures prevented a usable __SOURCE__ price{{ else if eq (printf "%.0f" $values.Reason.Value) "20" }}__SOURCE__ did not list this market{{ else }}__SOURCE__ price data is usable again{{ end }}
EOT
  )

  peg_active_source_failure_summaries = {
    for key, item in local.peg_active_sources : key => replace(
      local.peg_source_failure_summary_template,
      "__SOURCE__",
      local.peg_source_display_names[key],
    )
  }
  peg_active_source_failure_resolved_summaries = {
    for key, item in local.peg_active_sources : key => replace(
      local.peg_source_failure_resolved_summary_template,
      "__SOURCE__",
      local.peg_source_display_names[key],
    )
  }
  peg_previous_source_failure_summaries = {
    for key, item in local.peg_previous_sources : key => replace(
      local.peg_source_failure_summary_template,
      "__SOURCE__",
      local.peg_source_display_names[key],
    )
  }
  peg_previous_source_failure_resolved_summaries = {
    for key, item in local.peg_previous_sources : key => replace(
      local.peg_source_failure_resolved_summary_template,
      "__SOURCE__",
      local.peg_source_display_names[key],
    )
  }

  peg_indexed_pool_summary_template = chomp(<<-EOT
{{ if eq (printf "%.0f" $values.Reason.Value) "12" }}__ASSET__ pool data cannot be fetched{{ else if eq (printf "%.0f" $values.Reason.Value) "13" }}__ASSET__ pool is missing from indexed data{{ else if eq (printf "%.0f" $values.Reason.Value) "14" }}__ASSET__ indexed pool does not match the registry{{ else if eq (printf "%.0f" $values.Reason.Value) "15" }}__ASSET__ pool data is invalid{{ else if eq (printf "%.0f" $values.Reason.Value) "19" }}Multiple indexed-data failures are blocking the __ASSET__ pool{{ else }}__ASSET__ pool data is unavailable{{ end }}
EOT
  )
  peg_indexed_pool_resolved_summary_template = chomp(<<-EOT
{{ if eq (printf "%.0f" $values.Reason.Value) "12" }}__ASSET__ pool data could not be fetched{{ else if eq (printf "%.0f" $values.Reason.Value) "13" }}__ASSET__ pool was missing from indexed data{{ else if eq (printf "%.0f" $values.Reason.Value) "14" }}__ASSET__ indexed pool did not match the registry{{ else if eq (printf "%.0f" $values.Reason.Value) "15" }}__ASSET__ pool data was invalid{{ else if eq (printf "%.0f" $values.Reason.Value) "19" }}Multiple indexed-data failures blocked the __ASSET__ pool{{ else }}__ASSET__ pool data is available again{{ end }}
EOT
  )
}
