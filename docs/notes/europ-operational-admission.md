---
title: EUROP operational admission evidence
status: active
owner: eng
canonical: true
last_verified: 2026-08-11
doc_type: runbook
scope: peg-monitoring / operational-admission
review_interval_days: 90
garden_lane: operator-runbooks
---

# EUROP operational admission evidence

## Decision

EUROP is **Blocked** from operational **Live** admission. The public price
monitor, dashboard, and alerts are already deployed; this decision only says
that the stronger proof that responders can keep EURm loss within the approved
budget is incomplete.

The pinned input and deterministic evaluator are
[`2026-08-11.json`](../../scripts/fixtures/europ-operational-admission/2026-08-11.json)
and
[`europ-operational-admission.mjs`](../../scripts/europ-operational-admission.mjs).
The evaluator always returns `BLOCKED`; static numbers and flags cannot grant
readiness. A future implementation must execute and authenticate the complete
sequential loss model before the canonical onboarding gate can consider a Live
decision.

## Pinned Polygon configuration

All mutable values below were read at Polygon block `91830875`, hash
`0x3f7cc53580045d0e9c7e862406891a9e152b7b2c47b0eeed1b73bcebe214af25`,
timestamp `2026-08-11T12:29:00Z`.
PublicNode, dRPC, and 1RPC returned the same pin.
The deterministic diagnostic was evaluated at `2026-08-11T12:35:00Z` with a
maximum evidence age of 900 seconds; the pin was 360 seconds old.

| Area                | Measured configuration                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pool                | EURm/EUROP FPMM `0xcd8c6811d975981f57e7fb32e59f0bee66af3201`                                                                                                                                                 |
| Assets              | EURm token0 `0x4D502d735B4C574B487Ed641ae87cEaE884731C7` (18 decimals); EUROP token1 `0x888883b5F5D21fb10Dfeb70e8f9722B9FB0E5E51` (6 decimals)                                                               |
| Reserves            | `6,932.949238266138502114` EURm and `10,399.423858` EUROP                                                                                                                                                    |
| Pool administration | The FPMM owner and fee setter are the control Safe.                                                                                                                                                          |
| Fees                | 3 bps LP + 2 bps protocol = 5 bps total                                                                                                                                                                      |
| Trading-limit state | L0: 50,000 EUROP / 300 s, netflow `3,498.25` EUROP, last update `1785520845`; L1: 250,000 EUROP / 86,400 s, netflow `9,229.728525` EUROP, last update `1785453845`. Both use TradingLimitsV2 fixed-15 scale. |
| Control Safe        | `0x58099B74F4ACd642Da77b4B7966b4138ec5Ba458`; 4-of-6, nonce 9 at the pin.                                                                                                                                    |
| Manual-rate control | Feed `0xc22418a83DfC262B10a1f57E25309DB83E7eA79e`; rate 1, last updated `2026-07-16T15:19:19Z`, non-expired. The ValueDelta breaker is enabled with a 50-bps threshold.                                      |
| Enabled strategies  | Open `0x54e2Ae8c8448912E17cE0b2453bAFB7B0D80E40f` and Reserve `0xa0fB8b16ce6AF3634fF9F3f4F40E49E1C1ae4f0B`, each with a 300-second cooldown.                                                                 |
| Reserve access      | ReserveV2 `0x4255Cf38e51516766180b33122029A88Cb853806`; its direct EURm and EUROP balances were zero at the pin. Those balances are not an approved liquid-reserve value or a loss cap.                      |

Both trading-limit windows were expired at the pin. The six-hour capacity below
does not rely on that favorable state; it uses the durable worst reachable
limit state required by the onboarding runbook.

The checked-in snapshot is diagnostic evidence. The evaluator validates field
shape, Safe threshold/owner-count consistency, freshness, and arithmetic, but
it does not authenticate the RPC reads or any claimed Safe, rate, strategy,
budget, or model control. Those claims cannot clear the Blocked result.
It refuses to calculate capacity unless the snapshot identifies Polygon 137,
the expected pool and EUROP/EURm contracts and decimals, and a well-formed
positive block number and hash. Numeric fields use canonical integers only;
timestamps require an explicit UTC offset and valid calendar values.
A well-formed block number and hash are still unauthenticated. They are reported
separately from the expected EUROP/Polygon protocol identity so a future fresh
block is never mislabeled as the dated pinned block above.

The protected-system boundary is every EURm movement involving the FPMM, its
enabled liquidity strategies, ReserveV2, and the protocol-fee recipient. It
includes transfers, minting, and burning. The Safe and rate breaker are control
inputs; they are not treated as economic asset holders.
The Safe diagnostic's expected-control-structure field covers its address and
4-of-6 structure only. Nonce is reported as mutable point-in-time data and is
not part of that field; all Safe fields remain unauthenticated snapshot claims.

## Approved operating choices recorded for this review

[#1687](https://github.com/mento-protocol/monitoring-monorepo/issues/1687)
records the owner decisions:

- Philip Paetz owns signer coverage, with Bogdan Dumitru as backup.
- The active `@support-engineer` is the escalation route, resolved from the
  VictorOps / Splunk On-Call rotation.
- The end-to-end response time is `S = 6 hours` (`21,600` seconds).
- Safe nonce 8 is accepted as execution proof for the current threshold.
- The starter budget rule is `B = min(100,000 EURm, 0.5% of approved current
liquid reserve assets)`.

The policy does not yet define which custody accounts count as “current liquid
reserve assets,” which valuation feeds and haircuts apply, or how that result
becomes `B`. The exact current liquid-reserve value and approved numeric `B`
are therefore absent. The above human attestations also have no explicit expiry
or independent reviewer recorded yet.

There is one **unapproved conditional calculation** in the pinned snapshot:
the registered assets held by ReserveV2 plus its listed other-reserve Safe hold
`120,812.444400` USDC; with contemporaneous USDC/USD `0.9998` and EUR/USD
`1.15364`, that is `104,701.884392982212822024` EURm and produces
`523.509421964911064110` EURm at 0.5%. This is not `B`. It becomes usable only
if the accountable owner explicitly approves that custody boundary, valuation
method, and resulting number. The evaluator keeps `B` empty until then.

That inventory is shared. ReserveV2 also serves the enabled USDC/USDm pool
`0x463c0d1F04bcd99A1efCF94AC2a75bc19Ea4A7E5`, while the Open strategy also
serves the active EURm/USDm pool
`0x93e15A22fDa39FEfcCCe82D387A09cCF030EAD61`. The conditional figure is a
same-block inventory value only. A durable model must include or enforceably
exclude concurrent reachable transitions in those pools before treating the
inventory as available to EUROP.

## Six-hour swap capacity

The evaluator applies the canonical TradingLimitsV2 capacity formula with
`S = 21,600` seconds:

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

The pinned L0 and L1 signed netflows are inside their enforced `[-L, +L]`
intervals. The evaluator blocks values one fixed-15 unit beyond either edge.

This is a **monotone EUROP-input capacity**, not a EURm-loss result. `B` is in
EURm, so the two numbers cannot be compared directly. A future executable model
must derive a boundary-aligned EURm result for that capacity and separately
derive the full worst-case EURm result before either can be compared with `B`.

## Why the decision stays Blocked

- **No executable authenticated loss model:** the repository has no program
  that authenticates the inputs, advances every reachable swap, rate, and
  strategy transition, and calculates net EURm outflow across the protected
  boundary. This is an unconditional blocker in the current evaluator.
- **Static control claims are untrusted:** editing Safe, rate, strategy, budget,
  certificate, model flags, or claimed loss numbers in JSON cannot grant
  readiness or produce a passing budget comparison.
- **No numeric budget:** the approved liquid-reserve value and exact `B` are
  absent. The available `523.509421964911064110` EURm figure is only an
  unapproved conditional calculation.
- **No enforceable rate-transition bound:** the current configuration does not
  provide an enforced no-change, no-arbitrage, or maximum-successful-transition
  control for the six-hour interval.
- **Incomplete strategy boundary:** both strategies are enabled and neither
  has a documented, enforceable EURm-outflow bound for the six-hour interval.
  The Reserve strategy has EURm/USDm mint and burn permissions and no
  enforceable per-interval mint cap, so visible EURm balances cannot serve as
  that bound. Both strategy action checks were not rebalancable at the pin;
  that is a point-in-time observation, not a six-hour guarantee.
- **No complete loss model:** there is no deterministic, protected-boundary
  result that covers both rate transitions and every enabled strategy, either
  for the monotone capacity or for the worst case.
- **Incomplete certificate:** signer coverage, escalation route, execution
  proof, and budget approval have no explicit expiry; a reviewer is also not
  recorded. Expiries are checked against the explicit evaluation time, not the
  observation time.

The result is intentionally conservative. Any absent, stale, malformed, or
unsupported input remains a blocker rather than becoming an assumption.

## Re-run and review

Use the tracked snapshot to reproduce the current result:

```bash
node scripts/europ-operational-admission.mjs \
  --snapshot scripts/fixtures/europ-operational-admission/2026-08-11.json
```

The expected result is JSON with `status: BLOCKED` and process exit `1`.
Unreadable or invalid JSON exits `2`. Treat either nonzero result as a
fail-closed outcome; this command is not a success probe.

For a future decision, replace the snapshot with fresh same-block reads and
an explicit evaluation time and maximum evidence age. The current evaluator
still returns `BLOCKED` because it does not fetch or authenticate chain data and
does not execute the sequential loss model. Both budget comparisons remain
`not_evaluable`, even when a snapshot contains plausible-looking result values.
An owner-approved numeric `B` can be supplied directly with its accountable
approver and approval reference; otherwise the snapshot must include an
approved liquid-reserve denominator that reproduces the starter rule. Neither
choice clears the unconditional model and authentication blockers.

The governing procedure remains
[Peg monitoring onboarding and re-census](peg-monitoring-onboarding.md),
especially its response-SLA and loss-bound sections. Re-run the calculation
after any change to the Safe, rate control, fee, limits, strategy, protected
boundary, response SLA, budget, or certificate.

## Sources

- The checked-in snapshot above is the source of the pinned on-chain values and
  the current `BLOCKED` result.
- [Issue #1687](https://github.com/mento-protocol/monitoring-monorepo/issues/1687)
  records the accountable-owner decisions and accepted execution proof.
- The model follows the canonical
  [onboarding runbook](peg-monitoring-onboarding.md), including its
  TradingLimitsV2 formula and protected-boundary requirement.
- The control interpretation was verified against `mento-core`
  `07ecf3df5650a33ea6957f1ad2966e02c5082253`, in `TradingLimitsV2`, `FPMM`,
  and `ReserveLiquidityStrategy`.
