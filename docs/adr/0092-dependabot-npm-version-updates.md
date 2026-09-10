---
title: Dependabot batches npm version updates into Monday groups
status: active
owner: eng
canonical: true
last_verified: 2026-09-10
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0092 — Dependabot batches npm version updates into Monday groups

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

Since [ADR 0009](0009-supply-chain-hardening.md) the repository limited
Dependabot to the `github-actions` ecosystem. Routine npm bumps were manual
work behind `minimumReleaseAge: 4320` in `pnpm-workspace.yaml`. Security
advisories on `pnpm-lock.yaml` still arrived as Dependabot PRs under GitHub's
default `npm_and_yarn` group, on whatever day the advisory published.

Two costs grew with the workspace. Manual bumps landed in irregular batches
(for example PRs 2334, 2335, 2336, 2339 in one week) and depended on someone
remembering to run them. Security PRs carried no group boundary, so a
wallet-adjacent advisory and a lint-plugin advisory could share one PR.
`frontend-monorepo` already runs an `npm` Dependabot entry with themed groups
on the same Monday cadence, so the two repositories diverged in process for no
protocol reason.

## Decision

Add an `npm` update entry to `.github/dependabot.yml`:

- Weekly on Monday 06:00 UTC across the workspace root and the three
  standalone lockfile roots (`governance-watchdog`, the two alert function
  roots) in one entry, so a shared dependency lands in one grouped PR and
  `pnpm skew:check` keeps the catalog aligned.
- Cooldown of 7 days for minor and patch and 21 days for major. Security
  updates bypass cooldown by GitHub design.
- Version-update groups by blast radius: `next-runtime`, `envio-runtime`,
  `nest-runtime`, and `playwright-runtime` isolate deployment-coupled
  runtimes at every level; `chain-stack` keeps viem, abitype, `@noble/*`,
  `@scure/*`, and `@mento-protocol/*` minor and patch in one reviewed PR with
  majors arriving alone; `test-toolchain` and `lint-toolchain` batch
  development tooling; `production-misc` and `tooling` catch the rest.
- Security-update groups mirror the same boundaries (`chain-stack-security`,
  `next-runtime-security`, `envio-runtime-security`, `security-runtime`,
  `security-tooling`).
- Every npm PR stays on the operator-authorized merge path. The
  [ADR 0081](0081-narrow-dependabot-auto-merge-exception.md) lane requires the
  `github_actions` ecosystem and the exact `actions-minor-patch` group, so no
  npm PR can enter it.

`minimumReleaseAge` remains in force; Dependabot's cooldown is a second,
earlier floor for version updates, and the install-time gate still applies to
the resulting lockfile.

## Alternatives considered

- **Keep npm manual.** Rejected: the work was already happening, just
  irregularly and without a boundary between risk tiers.
- **One catch-all npm group.** Rejected: a Next.js or Envio runtime bump needs
  its own verification and would block the rest of the batch.
- **Disable Dependabot security updates to stop off-Monday PRs.** Rejected:
  security PRs are the only lane that bypasses the 3-day release-age hold.
  Their timing is set by advisory publication and cannot be scheduled.

## Consequences

- Expect up to nine grouped PRs on a Monday, plus ungrouped chain-stack majors.
  `open-pull-requests-limit: 12` leaves headroom.
- Adding a package that belongs to a runtime or chain group means editing the
  group patterns and the mirrored `exclude-patterns` in the same change.
- ADR 0081's context sentence that Dependabot is limited to GitHub Actions is
  historical as of this record; its decision and lane boundary are unchanged.

## Evidence

- `.github/dependabot.yml`, `scripts/production-infra-identity-contract/workflow.test.mjs`
  (pins the unchanged `github-actions` entry),
  [`docs/pr-checklists/ci-workflow-gates.md`](../pr-checklists/ci-workflow-gates.md) §7.
- Reference setup: `mento-protocol/frontend-monorepo` `.github/dependabot.yml`.
