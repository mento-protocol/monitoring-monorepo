The patch leaves a required Terraform test inconsistent with the new template. It also mishandles alert cycles across Grafana Error recovery and produces incorrect copy for source-less rules.

Full review comments:

- [P1] Update the native Terraform copy assertion — /private/tmp/fx-1999/alerts/rules/peg-message-templates.tf:14-14
  When the required alerts-rules Terraform test runs, this icon-only title fails `alerts/rules/peg-rule-definitions.tftest.hcl:66-74`, which still requires both `$alert.Annotations.summary` and `$alert.Annotations.resolved_summary` in `peg_slack_title`. The JavaScript linter was updated, but the native test was not, so CI's `terraform test -no-color` will fail; update that assertion to the new title/body contract.

- [P2] Track alert cycles across evaluation recovery — /private/tmp/fx-1999/ui-dashboard/src/app/api/peg-monitoring/alerts/peg-alert-events.ts:318-321
  For Alerting → Error → Normal, every `error-recovered*` transition closes only the separate error cycle, so the earlier alert cycle remains open and the UI retains an `alert active` event after Grafana returned to Normal. Conversely, Normal → Error → Alerting does not open an alert cycle, so its later clear is unpaired and loses its duration. Update the alert-cycle state when recovery targets Normal or Alerting.

- [P2] Use rule-specific copy when the source label is empty — /private/tmp/fx-1999/ui-dashboard/src/app/api/peg-monitoring/alerts/peg-alert-events.ts:230-230
  When Grafana errors on a source-less rule such as Heartbeat Missing, Indexed Pool Unreachable, or Policy Rollover Stuck, `labels.source` is empty and this call maps it to `Price source`. The dashboard therefore reports that Grafana could not evaluate a price-source rule even though that rule has no price source. Use the asset or rule name when the source label is empty.

- [P3] Update the canonical Slack title contract — /private/tmp/fx-1999/alerts/rules/peg-message-templates.tf:14-14
  This changes Slack titles to a status icon only, but `docs/notes/peg-monitoring.md:116-120` still states that Slack titles contain the severity icon plus the summary. Update that canonical copy contract to state that the linked summary now appears in the message body.
