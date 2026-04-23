# terraform/alerts

Grafana Cloud alert rules and Slack contact points for Mento v3 monitoring.

## Scope

- **In this module:** `grafana_rule_group` resources (5 groups, 9 rules) for FPMM pool health + metrics-bridge liveness, organised into one Grafana folder per `service` label (`FPMMs`, `Metrics Bridge`), plus two `grafana_contact_point` resources (`slack-alerts-critical`, `slack-alerts-warnings`).
- **Not in this module:** the root `grafana_notification_policy` — that's a singleton owned by [`aegis/terraform/grafana-alerts/notification-policies.tf`](../../../aegis/terraform/grafana-alerts/notification-policies.tf). Every rule here routes via its own `notification_settings` block, so we don't touch the policy tree.
- **Folder convention:** one folder per `service` label (same pattern Aegis uses for `Oracle Relayers`, `Reserve`, `Trading Modes`, `Trading Limits`). `oracles` and `cdps` folders will be added when their first rule groups land.

## State

Separate from `terraform/` (Vercel + Cloud Run): `gs://mento-terraform-tfstate-6ed6/monitoring-monorepo-alerts`. Backend uses default ADC — same as the sibling module.

## Prerequisites

1. **Slack app with bot token.** The "Grafana Alerts" app needs `chat:write` + `chat:write.public` scopes and must be invited (`/invite @Grafana Alerts`) to `#alerts-critical` and `#alerts-warnings`.
2. **Grafana Cloud service account token** with `Admin` role in the `clabsmento` stack (Grafana Cloud → Administration → Service accounts).

## Running

```bash
cp terraform.tfvars.example terraform.tfvars
# Paste the Slack bot token and Grafana SA token into terraform.tfvars.

pnpm alerts:init
pnpm alerts:plan
pnpm alerts:apply
```

Both secrets live in `terraform/alerts/terraform.tfvars` (gitignored). Matches the pattern of `terraform/terraform.tfvars` — one file, one place, both secrets.

## Smoke test

After `apply`, temporarily drop one threshold (e.g. set `params = [0.0]` on the Deviation Breach rule) and `terraform apply` again. Within ~2m, `#alerts-warnings` should receive a fire, then a resolve after reverting the change.

## Service label routing

Each rule attaches `service = "fpmms"` or `service = "metrics-bridge"`. Future oracles / cdps rule groups will attach their own service label and stay in this module — no notification-tree churn required.
