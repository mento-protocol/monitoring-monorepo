---
title: Retire the legacy local quality gate
status: active
owner: eng
canonical: true
last_verified: 2026-09-14
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0100 — Retire the legacy local quality gate

## Decision

The maintainer accepted the M6 observation receipt with explicit limits and
separately approved this atomic retirement. [Acceptance and approval](https://github.com/mento-protocol/monitoring-monorepo/issues/2128#issuecomment-5669434382)
record ten distinct merged PRs across September 4–14, production evidence,
506.90 runner-minutes including the failed recovery, the accepted timing limits,
and the missing indexer full-suite and live missing/extra-job observations.
Those missing observations remain limits; no new recovery system replaces them.

Delete the optional local gate, mapper, routing table, coordinator, prewarm,
locks/leases/sockets/journals implementation and their exclusive tests together.
Remove the temporary M6 collector and bounded recovery adapter. Keep the manual
open-PR no-skip workflow and retained deterministic CI. No schedule is added.

Normal author work continues through the direct checks in the
[PR operating card](../notes/pr-operating-card.md). Staged formatting stays on
pre-commit. Pre-push starts no verification. Required CI, automated review,
feedback/readiness, deployment and Terraform authority remain unchanged.
This PR does not modify the live ruleset or authorize its own merge.

## Retained consumers

The final consumer audit differs from the pre-M1 audit: autoreview was removed
in #2271. No current Sentry, deploy or package command imports the Darwin
identity/lineage or broker-preflight implementations. Their only executable
consumers were the deleted local gate and its tests. Restore them on rollback.

Retain these independent controls:

- `scripts/lib/mapped-command-process-identity.mjs` and its tests preserve
  marker descriptor authentication for Sentry's probe supervisor and the
  staged triage broker. Its workflow staging path and broker shim move with it.
- `scripts/workflows/indexer-handler-invariant-{contract,families}.mjs`
  preserve checklist ownership and completeness. The existing root indexer
  contract suite remains in CI.
- `scripts/check-agent-quality-gate-package-scripts.mjs` retains its stable
  name and pre-install entry points. It rejects changed trusted aliases and
  unsanctioned lifecycle hooks. Only aliases for deleted commands are removed.
- Sentry's independent self-run gate, CI wiring, broker and shell supervisor
  settlement tests remain. Only local-selector classification probes disappear.
- Documentation index/link checks, mandatory checklist contracts, dependency
  architecture checks, setup hooks and process-state refusal checks remain.

No file remains under `scripts/gate/`. Retained files are not counted as deleted
merely because their path moved. The final manifests and source allocation are
in `docs/metrics/verification-redesign-retirement.json` and the final
control-plane manifest. Frozen earlier metrics remain unchanged.

## Worktrees and state

The refreshed registry contains sixteen worktrees, all descendants of cutover
and all without a tracked or installed pre-push hook. The initial baseline and
intermediate observation worktrees have explicit retained/absent dispositions
in the retirement receipt. Old checkouts remain intact; retirement changes only
this source tree. An orphaned pre-cutover coordinator still holds a draining request and two drain obligations from September 4; its recorded owner no longer exists. Preserve that process and state for explicit recovery. This source retirement neither claims a clean drain nor signals the process. No runtime state root is removed, reset or repurposed.

## Rollback

Cutover is `d4d7e15eb5bc2b6d858ed2a788d7fa04bd2c21fd` (#2237).
The retirement PR and its merge record bind the retirement commit; record that
exact merge SHA in #2128 before closing it. The rollback rehearsal used
pre-retirement source `7623f5282c166dbc2c397f16169835427b3c3575`. The final
manifests also include main integration `e95372d0ef9542db7147497cbf1952e543dd9380`.

1. Stop merges through the normal human repository process.
2. Read ruleset `13494367`. Keep its strict current-base required checks. If
   protection drifted, restore the recorded known-safe ruleset only with
   separate operator approval. This PR changes no provider rule.
3. Revert the retirement commit first. Restore runtime, coordinator, aliases,
   shared containment and tests before any hook is enabled. Resolve later
   source conflicts without discarding current retained safeguards.
4. Revert cutover only after step 3. Restore the tracked pre-push hook and
   its Trunk action together. Verify the final #2042 identity/lineage behavior
   and mixed-version lock adoption with the focused tests.
5. Let the restored coordinator adopt or recover legacy state. Never clear the
   state root or signal bare PIDs to make recovery pass.

The disposable rollback proof uses local source only. It does not install the
restored hook in shared Git configuration or change the live ruleset.

## Consequences

ADRs 0007, 0069, 0076, 0080, 0088 and 0098 and the diagnostic mechanics note
are archived. ADR 0072 keeps its documentation CI job, without local-routing
self-tests. ADRs 0008 and 0033 keep their checklist and reminder requirements.
ADR 0075 remains archived under ADR 0084; no merge wrapper returns.

#2006 and #2032 lose their legacy scheduling/recovery scope. #2094's deleted
self-test environment failures no longer apply. #2042 remains completed;
its retained Sentry invariants and rollback obligations are preserved above.
Known diagnostic limitations do not become claims that recovery was fixed.
Merge and post-merge evidence remain necessary before #2128 and #2122 close.
