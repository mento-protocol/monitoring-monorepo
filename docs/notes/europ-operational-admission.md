---
title: EUROP operational admission evidence
status: active
owner: eng
canonical: true
last_verified: 2026-08-12
doc_type: runbook
scope: peg-monitoring / operational-admission
review_interval_days: 90
garden_lane: operator-runbooks
---

# EUROP operational admission evidence

## Decision

EUROP remains **Blocked** from operational **Live** admission. The public price
monitor, dashboard, and alerts are deployed. The tracked evaluator always
returns `BLOCKED` with both budget comparisons `not_evaluable`.

The pinned input and diagnostic evaluator are
[`2026-08-11.json`](../../scripts/fixtures/europ-operational-admission/2026-08-11.json)
and
[`europ-operational-admission.mjs`](../../scripts/europ-operational-admission.mjs).
They validate input shape and arithmetic only. They do not authenticate chain
state, execute a complete sequential loss model, or attest fork-source and
execution provenance. Static values and claims cannot grant readiness.

## Pinned Polygon configuration

The checked-in snapshot records Polygon block `91830875`, hash
`0x3f7cc53580045d0e9c7e862406891a9e152b7b2c47b0eeed1b73bcebe214af25`,
timestamp `2026-08-11T12:29:00Z`. It records the EURm/EUROP FPMM
`0xcd8c6811d975981f57e7fb32e59f0bee66af3201`, EURm token0 and EUROP token1,
the control Safe, manual-rate controls, both enabled strategies, and the
reviewed LP-custody boundary.

The evaluator requires Polygon `137`, the expected pool/contracts/decimals, a
positive canonical block number, a well-formed block hash, canonical integers,
and timestamps with an explicit UTC offset. It reports identity and arithmetic
diagnostics separately from authentication. A well-formed value is still an
unattested snapshot claim.

The protected-system boundary is every EURm movement involving the FPMM, its
enabled liquidity strategies, ReserveV2, the protocol-fee recipient, and LP
custody Safe `0x3fac3feF4408CFB03aa190fbD94D571C42cFd1f1`. It includes
transfers, minting, burning, and LP exits. An in-boundary pro-rata burn to the
approved custody Safe is internal custody movement. The future model must fail
closed on custody-control drift or an LP exit outside the approved boundary.

## Approved operating choices

[#1687](https://github.com/mento-protocol/monitoring-monorepo/issues/1687)
records the accountable-owner decisions:

- Philip Paetz owns signer coverage; Bogdan Dumitru is backup.
- The active `@support-engineer`, resolved from VictorOps / Splunk On-Call, is
  the escalation route.
- The response period is `S = 6 hours` (`21,600` seconds).
- Safe nonce 8 is the accepted execution evidence for the current threshold.
- Philip approved `B = 100,000 EURm` through [issue comment
  5254428553](https://github.com/mento-protocol/monitoring-monorepo/issues/1687#issuecomment-5254428553).
- Philip is the independent reviewer.
- Signer coverage, escalation, execution evidence, and budget approval expire
  at `2026-11-09T14:21:33Z`.
- Open and Reserve strategies remain enabled; the ValueDelta threshold remains
  50 bps.
- The emergency halt is the control Safe reporting exact `0.994`
  (`994000000000000000000000` at 24 decimals) to SortedOracles feed
  `0xc22418a83DfC262B10a1f57E25309DB83E7eA79e`. The intended effect is trading
  mode `1`, which stops swaps and both strategy rebalances.

These are policy targets and snapshot claims. They do not clear the admission
blockers.

## Six-hour swap capacity

The evaluator derives the documented TradingLimitsV2 monotone EUROP-input
capacity for `S = 21,600` seconds:

```text
D_live,i(S) = 2L_i + L_i * ceil(S / W_i)
D_net(S) = min(D_live,i(S))
```

| Limit                         |                Six-hour capacity |
| ----------------------------- | -------------------------------: |
| L0 (50,000 EUROP / 300 s)     | 3,700,000 EUROP fixed-15 netflow |
| L1 (250,000 EUROP / 86,400 s) |   750,000 EUROP fixed-15 netflow |
| Binding `D_net(S)`            |   750,000 EUROP fixed-15 netflow |
| Fee-adjusted maximum input    |             750,375.187593 EUROP |

This is EUROP-input capacity, not a EURm-loss result. It cannot be compared
with `B` until a future complete boundary-aligned model derives EURm outflow.

## Local-fork diagnostic

The localhost-only runner observes a candidate 51-cycle path from the pinned
configuration: 2,000 EUROP input, 1,999 EURm output, then Reserve rebalance in
each cycle. Its local Anvil execution observed 153 successful receipts,
51 successful Reserve rebalances, 15,080 elapsed seconds, and 101,949 EURm
external outflow. The amount is 1,949 EURm above the approved budget.

That 101,949 EURm result is useful engineering evidence about the fixed local
candidate path. It is an unattested local diagnostic. It cannot establish
fork-source provenance, independent execution provenance, production activity,
or the complete worst-case loss. It therefore cannot support Live admission or
change either evaluator budget comparison from `not_evaluable`.

The runner also observes the candidate emergency-halt path: it checks the
fixed 0.994 report, trading-mode change, swap and both rebalance failures, and
the 1.0 restoration path. Those observations are likewise unattested local
diagnostics.

## Why the decision stays Blocked

- `EXECUTABLE_LOSS_MODEL_NOT_IMPLEMENTED`: no complete authenticated
  sequential model covers every reachable protected-boundary EURm transition.
- `SNAPSHOT_NOT_AUTHENTICATED`: the checked-in values are diagnostic snapshot
  claims, not authenticated current state.
- `LOCAL_FORK_PROVENANCE_UNATTESTED`: the local runner has no independent
  execution or fork-source attestation.
- The existing configuration has no enforceable rolling six-hour boundary over
  swaps, both strategies, Reserve mint-to-exit paths, and unapproved LP exits.

The forward control remains an enforceable rolling six-hour, per-pool net
external EURm-outflow guard of at most 100,000 EURm covering that full
boundary. A future admission implementation must authenticate current state,
run the complete model, and obtain independent execution and fork-source
attestation.

## Run and review

Run the snapshot evaluator:

```bash
node scripts/europ-operational-admission.mjs \
  --snapshot scripts/fixtures/europ-operational-admission/2026-08-11.json
```

It emits `status: BLOCKED`, `worstCaseBudgetComparison.status: not_evaluable`,
and unattested local-fork labels, then exits `1`. It rejects `--proof-dir` with
structured `BLOCKED` JSON, blocker
`LOCAL_FORK_ARTIFACT_IMPORT_UNSUPPORTED`, and exit `2`.

Run the local diagnostic only with a read-only Polygon source URL:

```bash
POLYGON_RPC_URL=https://polygon-rpc.example \
  scripts/europ-operational-admission-proof.sh
```

The runner starts separate fresh localhost-only Anvil forks for the candidate
path and halt/restore checks. It rejects an execution RPC URL, uses unlocked
local Anvil accounts only, and checks the chain, pinned block, receipts, action
traces, safety assertions, and manifests before it prints its output. Its
output remains an unattested local diagnostic and is never consumed by the
evaluator.

No production change is authorized by this runbook. Re-run the review after a
change to the Safe, rate control, fee, limits, strategy, protected boundary,
response SLA, budget, or certificate.

## Sources

- The checked-in snapshot is the source of the dated diagnostic values.
- [Issue #1687](https://github.com/mento-protocol/monitoring-monorepo/issues/1687)
  records the owner decisions and expiry details.
- [Peg monitoring onboarding and re-census](peg-monitoring-onboarding.md)
  owns the response-SLA and loss-bound procedure.
