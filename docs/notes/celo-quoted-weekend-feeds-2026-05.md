# CELO-quoted weekend feed evidence - 2026-05-26

The weekend-noise backlog item asked whether CELO-quoted counterparts for the
newly-muted `<FX>USD` feeds should also be added to
`aegis/terraform/grafana-alerts/locals.tf:weekend_disabled_feeds`.

Grafana datasource: `grafanacloud-prom`

Query window: Fri 2026-05-22 20:30 UTC through Sun 2026-05-24 23:30 UTC
(`max_over_time(...[51h])` at `2026-05-24T23:30:00Z`).

```promql
max by (rateFeed, chain) (
  max_over_time(
    SortedOracles_isOldestReportExpired_isExpired{
      chain="celo",
      rateFeed=~"CELO(AUD|BRL|CAD|CHF|EUR|GBP|JPY|KES|NGN|ZA[R])"
    }[51h]
  )
)
```

Result: every target feed stayed at `0`:

- `CELOAUD`
- `CELOBRL`
- `CELOCAD`
- `CELOCHF`
- `CELOEUR`
- `CELOGBP`
- `CELOJPY`
- `CELOKES`
- `CELONGN`
- the CELO-quoted South African rand feed

No `weekend_disabled_feeds` change is needed for those CELO-quoted FX feeds.

Broader `rateFeed=~"CELO.*"` spot-checks did find `CELOPHP` and `CELOETH`
maxing at `1` over the wider May 22-25 weekend window. `CELOPHP` is already in
`weekend_disabled_feeds`; `CELOETH` is not part of the FX-market counterpart
set this backlog item covered.
