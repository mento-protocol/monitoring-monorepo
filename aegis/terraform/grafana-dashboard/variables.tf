variable "grafana_service_account_token" {
  description = "Grafana Service Account Token allowing Terraform to manage Grafana resources on the Mento Stack"
  type        = string
  sensitive   = true
}

variable "aegis_folder" {
  description = "The aegis folder in which to create the Grafana dashboard"
  type = object({
    uid = string
  })
}

locals {
  # Per-chain registry driving the relayer-signer panels. Mirrors the registry
  # in grafana-alerts/locals.tf (kept in sync by hand, as the chains list was).
  # To add an EVM chain (e.g. polygon mainnet/testnet) add an entry here.
  #
  #   title     → panel title suffix, e.g. "CELO Balances ... [Celo]"
  #   metric    → Prometheus metric for the native gas-token balance
  #   symbol    → gas-token ticker shown in panel title + y-axis label
  #   threshold → red danger-line drawn on the balance timeseries
  chains = {
    "celo" = {
      title     = "Celo"
      metric    = "CELOToken_balanceOf"
      symbol    = "CELO"
      threshold = 10
    }
    "celo-sepolia" = {
      title     = "Celo-Sepolia"
      metric    = "CELOToken_balanceOf"
      symbol    = "CELO"
      threshold = 10
    }
    "monad" = {
      title     = "Monad"
      metric    = "Native_balanceOf"
      symbol    = "MON"
      threshold = 50
    }
    "monad-testnet" = {
      title     = "Monad-Testnet"
      metric    = "Native_balanceOf"
      symbol    = "MON"
      threshold = 50
    }
  }

  prometheus_datasource_uid = "grafanacloud-prom"
  common_panel_config = {
    datasource = {
      type = "prometheus"
      uid  = local.prometheus_datasource_uid
    }
    legend = {
      showLegend  = true
      displayMode = "list"
      placement   = "bottom"
    }
    tooltip = {
      mode = "single"
      sort = "none"
    }
  }

  state_timeline_config = {
    type = "state-timeline"
    options = {
      mergeValues = false
      showValue   = "never"
      alignValue  = "center"
      rowHeight   = 0.9
    }
    fieldConfig = {
      defaults = {
        custom = {
          lineWidth   = 0
          fillOpacity = 70
          spanNulls   = false
          insertNulls = false
        }
        color = {
          mode = "continuous-GrYlRd"
        }
      }
    }
  }
}
