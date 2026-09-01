The patch breaks the required Terraform test and leaves multiple reachable Grafana state transitions represented incorrectly or incompletely. Several new tests also pass for reasons unrelated to the behavior they intend to protect.

Full review comments:

- [P1] Update the Terraform assertion for icon-only titles — /private/tmp/fx-1999/alerts/rules/peg-message-templates.tf:14-14
  The required `Test Peg rule definitions` CI job (`.github/workflows/ci.yml:871-879`) still asserts that `peg_slack_title` contains both summary annotations at `peg-rule-definitions.tftest.hcl:68-69`. This template now intentionally contains neither, so every CI run for this change fails. Update the assertion to enforce the new icon-title and linked-body contract, as required by [alerts/AGENTS.md:52-55](/private/tmp/fx-1999/alerts/AGENTS.md:52).

- [P1] Close the breach when Error recovers to Normal — /private/tmp/fx-1999/ui-dashboard/src/app/api/peg-monitoring/alerts/peg-alert-events.ts:350-352
  For `Alerting → Error → Normal`, the recovery closes only the `fingerprint:error` cycle while the earlier `fingerprint:alert` cycle remains open. The history therefore omits the breach-cleared transition and shows only the prior raised entry plus monitoring recovery, even though Grafana returned to Normal. Close the alert cycle as well when an Error recovery reaches Normal or Pending.

- [P2] Query and classify Error-to-Pending recoveries — /private/tmp/fx-1999/ui-dashboard/src/app/api/peg-monitoring/alerts/peg-alert-events.ts:109-113
  When a rule with a nonzero `for` duration recovers from Error while its condition remains true, Grafana can transition to Pending. This classifier handles only Alerting and Normal, and `errorStateHistoryUrl` requests only `previous=Error&current=Normal`, so Recent alerts retains the monitoring failure without its recovery. Query and classify Error-to-Pending as a recovery; [ui-dashboard/AGENTS.md:26-32](/private/tmp/fx-1999/ui-dashboard/AGENTS.md:26) requires explicit degraded-state behavior and coverage.

- [P2] Seed alert pairing at an Error-to-Alerting boundary — /private/tmp/fx-1999/ui-dashboard/src/app/api/peg-monitoring/alerts/peg-alert-events.ts:320-321
  If the seven-day window starts with `Error → Alerting` and later contains `Alerting → Normal`, this cycle key records the first transition only in the error lane. The later clear has no alert opener, so it loses the duration and original measured evidence. Seed alert pairing from this boundary recovery without emitting a duplicate raised event.

- [P2] Avoid naming source-less rules as price-source rules — /private/tmp/fx-1999/ui-dashboard/src/app/api/peg-monitoring/alerts/peg-alert-events.ts:230-234
  Several Peg rules, including structural and heartbeat rules, use an empty `source` label. `pegAlertSourceName("")` returns `Price source`, so the new failure copy says `Grafana could not evaluate the Price source Peg rule` for failures unrelated to a price source. Use a generic or rule-specific evaluation target when the source label is empty.

- [P2] Update the canonical Peg runbook with the new contract — /private/tmp/fx-1999/alerts/rules/peg-message-templates.tf:4-6
  The canonical `docs/notes/peg-monitoring.md:118-133` still says Slack titles contain the summary and that history reads only fired and resolved transitions. This patch makes titles icon-only and adds Error-state history, so operators will follow stale behavior after merge. Update both statements to keep canonical context current as required by [AGENTS.md:25-27](/private/tmp/fx-1999/AGENTS.md:25).

- [P2] Create a fresh Response for each fallback fetch — /private/tmp/fx-1999/ui-dashboard/src/app/api/peg-monitoring/alerts/__tests__/route.test.ts:819-819
  The route now performs four concurrent fetches, but these three fault tests use one consumable `Response` for every remaining call at lines 819, 832, and 846. After one call reads the body, another fails from body reuse, so the expected 502 can occur even if malformed-frame, size, or truncation validation is broken. Return a fresh `Response` from a mock implementation for each request.

- [P2] Assert against breach copy that can actually render — /private/tmp/fx-1999/ui-dashboard/src/app/peg-monitoring/__tests__/recent-alerts.test.tsx:190-193
  No production explanation contains the exact text `sell price is below peg`, so this assertion still passes if the evaluation-failure early return is removed and the normal breach explanation renders. Assert that the actual movement-explanation sentence is absent so the test protects against falsely describing a monitoring failure as a peg breach.

- [P3] Make the Slack-template test fail closed — /private/tmp/fx-1999/scripts/alerts/alert-rules-lint.test.mjs:1215-1220
  The extraction does not validate either `indexOf` result, and the link assertions later search the complete Terraform file instead of the Slack message resource. A marker rename or duplicate string in another template can therefore keep this test green after the title or message contract breaks. Validate ordered resource boundaries and assert each contract within its extracted resource.
