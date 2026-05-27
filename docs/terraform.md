---
title: Terraform Stacks
status: active
owner: eng
canonical: true
last_verified: 2026-05-27
---

# Terraform Stacks

`terraform.stacks.json` is the machine-readable registry for Terraform roots.
Use it instead of inferring ownership from directory names.

| Stack             | Path               | State prefix          | Owns                                                                                                                                      | Plan/apply policy                                                 |
| ----------------- | ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `platform`        | `terraform/`       | `monitoring-monorepo` | Dashboard Vercel project, Upstash, GCP project/APIs, Metrics Bridge Cloud Run shape, Aegis App Engine/Grafana Agent bootstrap, CI WIF/IAM | Manual plan; human-approved apply                                 |
| `alerts-rules`    | `alerts/rules/`    | `alerts-rules`        | Protocol Grafana alert rules, Grafana folders, global Grafana notification policy, contact points, message templates, mute timings        | Manual plan; human-approved apply                                 |
| `alerts-delivery` | `alerts/infra/`    | `alerts-infra`        | QuickNode webhooks, alert Cloud Function, Discord channel management, Sentry bridge, Slack channel lifecycle, related GCP resources       | PR plan; `main` apply through the `production` GitHub Environment |
| `aegis`           | `aegis/terraform/` | `aegis`               | Aegis Grafana dashboard, Aegis folder, Aegis service-health rule group                                                                    | Manual plan; human-approved apply                                 |

## Commands

```bash
pnpm tf list
pnpm tf validate <stack-id>
pnpm tf plan <stack-id>
pnpm tf apply <stack-id>
```

Existing aliases remain:

```bash
pnpm infra:plan
pnpm alerts:rules:plan
pnpm alerts:infra:plan
pnpm aegis:tf:plan
```

`pnpm tf validate` without a stack validates all registered stacks with
`terraform fmt -check -recursive`, `terraform init -backend=false`, and
`terraform validate`.

## CI Model

`.github/workflows/infra.yml` asks `scripts/tf-stacks.mjs` which stacks changed
and validates only those stack roots. The workflow summary prints the stack's
state prefix plus its plan/apply policy so reviewers can see whether a PR is
validation-only, manual-plan, or auto-apply eligible.

`.github/workflows/ci.yml` uses the same registry-backed changed-stack
validation inside the required `CI / ci` sentinel. Keep Terraform path routing
in `terraform.stacks.json` rather than duplicating stack ownership in workflow
YAML.

Only `alerts-delivery` has CI apply behavior, and that remains gated by the
`production` GitHub Environment. No platform, alerts-rules, or Aegis apply is
automatic.

## Grafana Alert Ownership Migration

This cleanup moves protocol Grafana ownership from the old Aegis module into
`alerts-rules`. Aegis keeps only `grafana_rule_group.aegis_service_alerts`,
with a same-state `moved` block from
`module.grafana_alerts.grafana_rule_group.aegis_service_alerts`.

Before the first plan after this code lands, migrate the remote state exactly
once. Do not run `terraform apply` as part of this migration.

```bash
set -euo pipefail

MIGRATION_DIR="$(mktemp -d -t mento-grafana-alert-state-XXXXXXXXXX)"

terraform -chdir=aegis/terraform init
terraform -chdir=alerts/rules init

terraform -chdir=aegis/terraform state pull > "$MIGRATION_DIR/aegis.before.tfstate"
terraform -chdir=alerts/rules state pull > "$MIGRATION_DIR/alerts-rules.before.tfstate"
cp "$MIGRATION_DIR/aegis.before.tfstate" "$MIGRATION_DIR/aegis.work.tfstate"
cp "$MIGRATION_DIR/alerts-rules.before.tfstate" "$MIGRATION_DIR/alerts-rules.work.tfstate"

mv_state() {
  terraform state mv \
    -state="$MIGRATION_DIR/aegis.work.tfstate" \
    -state-out="$MIGRATION_DIR/alerts-rules.work.tfstate" \
    "$1" "$2"
}

mv_state 'grafana_folder.oracle_relayers' 'grafana_folder.oracle_relayers'
mv_state 'grafana_folder.trading_modes' 'grafana_folder.trading_modes'
mv_state 'grafana_folder.trading_limits' 'grafana_folder.trading_limits'

mv_state 'module.grafana_alerts.grafana_rule_group.oracle_relayers' 'grafana_rule_group.oracle_relayers'
mv_state 'module.grafana_alerts.grafana_rule_group.reserve_balances' 'grafana_rule_group.reserve_balances'
mv_state 'module.grafana_alerts.grafana_rule_group.trading_modes' 'grafana_rule_group.trading_modes'
mv_state 'module.grafana_alerts.grafana_rule_group.trading_limits' 'grafana_rule_group.trading_limits'

mv_state 'module.grafana_alerts.grafana_notification_policy.all' 'grafana_notification_policy.all'
mv_state 'module.grafana_alerts.grafana_mute_timing.weekend_mute' 'grafana_mute_timing.weekend_mute'

mv_state 'module.grafana_alerts.grafana_contact_point.discord_channel_oracle_relayers_staging' 'grafana_contact_point.discord_channel_oracle_relayers_staging'
mv_state 'module.grafana_alerts.grafana_contact_point.discord_channel_oracle_relayers_prod' 'grafana_contact_point.discord_channel_oracle_relayers_prod'
mv_state 'module.grafana_alerts.grafana_contact_point.discord_channel_reserve' 'grafana_contact_point.discord_channel_reserve'
mv_state 'module.grafana_alerts.grafana_contact_point.discord_channel_trading_modes_staging' 'grafana_contact_point.discord_channel_trading_modes_staging'
mv_state 'module.grafana_alerts.grafana_contact_point.discord_channel_trading_modes_prod' 'grafana_contact_point.discord_channel_trading_modes_prod'
mv_state 'module.grafana_alerts.grafana_contact_point.discord_channel_aegis' 'grafana_contact_point.discord_channel_aegis'
mv_state 'module.grafana_alerts.grafana_contact_point.discord_channel_trading_limits' 'grafana_contact_point.discord_channel_trading_limits'
mv_state 'module.grafana_alerts.grafana_contact_point.discord_channel_catch_all' 'grafana_contact_point.discord_channel_catch_all'
mv_state 'module.grafana_alerts.grafana_contact_point.splunk_on_call' 'grafana_contact_point.splunk_on_call'
mv_state 'module.grafana_alerts.grafana_contact_point.slack_alerts_critical' 'grafana_contact_point.slack_alerts_critical'
mv_state 'module.grafana_alerts.grafana_contact_point.slack_alerts_oracles' 'grafana_contact_point.slack_alerts_oracles'
mv_state 'module.grafana_alerts.grafana_contact_point.slack_alerts_pools' 'grafana_contact_point.slack_alerts_pools'
mv_state 'module.grafana_alerts.grafana_contact_point.slack_alerts_reserve' 'grafana_contact_point.slack_alerts_reserve'
mv_state 'module.grafana_alerts.grafana_contact_point.slack_alerts_infra' 'grafana_contact_point.slack_alerts_infra'
mv_state 'module.grafana_alerts.grafana_contact_point.slack_alerts_testnet' 'grafana_contact_point.slack_alerts_testnet'

mv_state 'module.grafana_alerts.grafana_message_template.discord' 'grafana_message_template.discord'
mv_state 'module.grafana_alerts.grafana_message_template.slack_oracle_stale_price_alert_title' 'grafana_message_template.slack_oracle_stale_price_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.slack_oracle_stale_price_alert_message' 'grafana_message_template.slack_oracle_stale_price_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.slack_oracle_relayer_low_balance_alert_title' 'grafana_message_template.slack_oracle_relayer_low_balance_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.slack_oracle_relayer_low_balance_alert_message' 'grafana_message_template.slack_oracle_relayer_low_balance_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.slack_reserve_balance_alert_title' 'grafana_message_template.slack_reserve_balance_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.slack_reserve_balance_alert_message' 'grafana_message_template.slack_reserve_balance_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.slack_trading_mode_alert_title' 'grafana_message_template.slack_trading_mode_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.slack_trading_mode_alert_message' 'grafana_message_template.slack_trading_mode_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.slack_trading_limits_alert_title' 'grafana_message_template.slack_trading_limits_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.slack_trading_limits_alert_message' 'grafana_message_template.slack_trading_limits_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.slack_aegis_service_alert_title' 'grafana_message_template.slack_aegis_service_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.slack_aegis_service_alert_message' 'grafana_message_template.slack_aegis_service_alert_message'

mv_state 'module.grafana_alerts.grafana_message_template.victorops_oracle_stale_price_alert_title' 'grafana_message_template.victorops_oracle_stale_price_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_oracle_stale_price_alert_message' 'grafana_message_template.victorops_oracle_stale_price_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_oracle_relayer_low_balance_alert_title' 'grafana_message_template.victorops_oracle_relayer_low_balance_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_oracle_relayer_low_balance_alert_message' 'grafana_message_template.victorops_oracle_relayer_low_balance_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_reserve_balance_alert_title' 'grafana_message_template.victorops_reserve_balance_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_reserve_balance_alert_message' 'grafana_message_template.victorops_reserve_balance_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_trading_mode_alert_title' 'grafana_message_template.victorops_trading_mode_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_trading_mode_alert_message' 'grafana_message_template.victorops_trading_mode_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_trading_limits_alert_title' 'grafana_message_template.victorops_trading_limits_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_trading_limits_alert_message' 'grafana_message_template.victorops_trading_limits_alert_message'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_aegis_service_alert_title' 'grafana_message_template.victorops_aegis_service_alert_title'
mv_state 'module.grafana_alerts.grafana_message_template.victorops_aegis_service_alert_message' 'grafana_message_template.victorops_aegis_service_alert_message'

terraform -chdir=aegis/terraform state push "$MIGRATION_DIR/aegis.work.tfstate"
terraform -chdir=alerts/rules state push "$MIGRATION_DIR/alerts-rules.work.tfstate"
```

After the state push, verify ownership before planning:

```bash
terraform -chdir=alerts/rules state list | grep -E 'grafana_(rule_group|notification_policy|contact_point|message_template|mute_timing|folder)'
terraform -chdir=aegis/terraform state list | grep grafana_rule_group
pnpm alerts:rules:plan
pnpm aegis:tf:plan
```

Expected result: protocol rule groups and global routing resources appear only
in `alerts-rules`; Aegis state contains the dashboard resources and
`grafana_rule_group.aegis_service_alerts`.
