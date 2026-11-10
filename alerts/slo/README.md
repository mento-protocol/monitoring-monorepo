<!-- agent-context: title="Service Level Objectives" status=active owner=eng canonical=true last_verified=2026-10-30 doc_type=reference scope=alerts/slo review_interval_days=90 garden_lane=package-readmes-reference -->

# alerts/slo

[`slos.yaml`](slos.yaml) holds the service level objectives for Mento monitoring
and the Gateway that runs its agents, in [OpenSLO v1](https://github.com/OpenSLO/OpenSLO).
Nothing here deploys. No Terraform stack reads this folder, and it creates no
Grafana rule. [ADR 0111](../../docs/adr/0111-openslo-definitions-without-generated-rules.md)
records why.

Hardin, the SRE agent, reads the file from `main` once a day. It reports a
budget that has run out or is burning at 1× or more over both 3 days and 6 hours.
Its monthly service review shows attainment against target.

## Annotations

- `mento.org/sli-status`: `measured` means a reader can compute the SLI today.
  `pending` means the data source does not exist yet, so the SLO stays listed
  and is never evaluated.
- `mento.org/provisional`: `"true"` means the target is a starting guess. The
  next review confirms or changes it.

## Targets

| SLO                      | Target | Basis                                                             |
| ------------------------ | ------ | ----------------------------------------------------------------- |
| `indexer-availability`   | 99.5%  | Measured: 28 days of Prometheus history at the 120 s threshold    |
| `indexer-freshness`      | 99.5%  | Provisional: no stored lag series                                 |
| `dashboard-availability` | 99.5%  | Provisional: synthetic checks are new, no history yet             |
| `alert-delivery`         | 99.9%  | Provisional: no canary exists                                     |
| `alert-precision`        | 90%    | Provisional: industry guidance, 3 days of incident ledgers so far |
| `cron-automations`       | 97%    | Provisional: just under the 7 days of run history available       |
| `gateway-liveness`       | 95%    | Provisional: just under the 24 days of heartbeat flips available  |
| `change-failure-rate`    | ≤ 15%  | Provisional: industry guidance, 3 days of incident ledgers so far |

`dashboard-availability` reads `probe_success` from the Grafana Synthetic
Monitoring HTTP check in [`alerts/rules/synthetic-monitoring.tf`](../rules/synthetic-monitoring.tf).
It stays `pending` until that check has run for the full 28-day window: the
fallback counts every minute without a sample as failed, so evaluating it
earlier reports budget burned by minutes before the check existed. Flip it to
`measured` in a reviewed PR once `sm_check_info{job="ui-dashboard"}` is 28 days
old. Its `or vector(0)` fallback is deliberate: a minute with no
`probe_success` sample counts as down, as for `indexer-availability`. That
includes monitoring failures, such as a revoked Synthetic Monitoring token or
disabled checks, so a burn on this SLO first needs `sm_check_info` to confirm
the checks were running.

`indexer-availability` shows that metrics-bridge can read the indexer. It does
not show that the data is current; that is `indexer-freshness`.

`change-failure-rate` approximates DORA's measure. It counts incidents tagged as
change-caused against PRs merged in the same window, because ledgers do not name
the causal PR. Hardin reports that rate directly, as incidents per merged PR.
Two incidents on one merged PR read as 200%, a missed target; no report computes
the inverted ratio in `slos.yaml`, so it cannot go negative.

## Error budget policy

- Budget gone: ship only reliability work and security fixes for that service
  until attainment is back above target.
- One incident that uses more than 20% of a 4-week budget gets a postmortem with
  at least one prevention item.
- The repo owner decides any disagreement.

## Review

Next review: 2027-01-28. Confirm or change every provisional target against the
last 90 days, then set the next date here.

## Changing an SLO

Keep the file one YAML sequence of SLO objects: the deploy-staging contract
parses each tracked YAML file as one document, so a `---` separator fails CI.

Keep `metadata.name` stable: reports and history key on it. Mimir rejects
queries longer than 32 days here, so a Prometheus SLI stays inside the 28-day
window. A Prometheus indicator must return one series, or the worst series is
what counts. End its query with a fallback that fails the threshold, as
`indexer-availability` does, so a series that disappears uses up budget instead
of dropping out of the calculation. Aggregate the left side too: a labelled
series and an unlabelled fallback are two series, and the sparse one wins.
