---
title: Use GitHub for ordinary pull request merges
status: active
owner: eng
canonical: true
last_verified: 2026-09-01
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0083 — Use GitHub for ordinary pull request merges

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

ADR 0075 added a local merge wrapper. The wrapper repeated the repository's PR
checks, asked for typed confirmation, wrote a local consent ledger, and called
the GitHub merge API. Its implementation and tests created a large maintenance
surface for a small repository with one active human maintainer.

The operator uses the wrapper as a convenience. The repository does not need a
separate local enforcement system for ordinary human merges. GitHub already
shows the current PR state and applies the repository's branch rules at merge
time.

## Decision

Delete the local merge wrapper, its tests, its package commands, and its live
workflow documentation. A human operator normally merges through the GitHub UI.

The default agent workflow drives a PR to ALL_CLEAR and then stops. An agent
can merge only when the user gives explicit, direct approval for that specific
merge. The agent then rechecks the current PR state and uses GitHub directly.
The merge request must bind the probed head SHA and abort on a mismatch.
`ship it`, ALL_CLEAR, and general workflow approval do not authorize a merge.

Remove the wrapper-specific agent command denies for `gh pr merge` and the
consent-ledger ignore. The general approval rule remains in the operating card.
Keep the narrow unattended Dependabot exception from ADR 0081. Any new
unattended merge lane needs a separate reviewed decision.

## Alternatives considered

- **Keep the local wrapper as an optional convenience.** Rejected. Its code,
  tests, routing, and documentation cost more to maintain than the convenience
  provides.
- **Replace it with a GitHub-side merge-operator Team, credential, or App.**
  Rejected as disproportionate for this repository. Issue #2091 records that
  decision.
- **Remove the Dependabot exception and require a UI merge for every PR.**
  Rejected. ADR 0081 keeps the user-approved automatic lane for its bounded
  routine update group.

## Consequences

- The repository no longer maintains a second merge implementation or its
  local consent protocol.
- The operator uses GitHub's current PR state and branch-rule result when they
  merge.
- The repository does not create a separate merge-operator Team, credential,
  App, or local ledger for ordinary merges.
- Agent tooling no longer adds wrapper-specific merge-command denies. The
  operating-card approval rule remains the policy boundary.
- ADR 0075 remains archived as the record of the retired design.
- ADR 0081 remains the only unattended merge lane.

## Evidence

- `docs/notes/pr-operating-card.md` defines the current operator merge path.
- `.github/workflows/dependabot-auto-merge.yml` implements the narrow machine
  exception in ADR 0081.
- Issue #2196 records this retirement.
