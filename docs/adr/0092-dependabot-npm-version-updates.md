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

- Weekly on Monday 06:00 UTC across the workspace root, the three
  standalone lockfile roots (`governance-watchdog`, the two alert function
  roots), and the lockfile-less `sentry-ingest-watcher` Cloud Function
  manifest, in one entry, so a shared dependency lands in one grouped PR and
  `pnpm skew:check` keeps the catalog aligned.
- Cooldown of 7 days for minor and patch and 21 days for major. Security
  updates bypass cooldown by GitHub design.
- Version-update groups by blast radius: `next-runtime`, `envio-runtime`,
  `nest-runtime`, and `playwright-runtime` isolate deployment-coupled
  runtimes at every level; `chain-stack` keeps viem, abitype, `@noble/*`,
  `@scure/*`, and `@mento-protocol/*` minor and patch in one reviewed PR with
  majors arriving alone; `test-toolchain` and `lint-toolchain` batch
  development tooling at every level; `production-misc` catches remaining
  production minor and patch updates, and `tooling` catches remaining
  development updates. Production majors outside the named groups arrive as
  individual PRs so each gets its own review.
- Security-update groups mirror the same boundaries (`next-runtime-security`,
  `envio-runtime-security`, `nest-runtime-security`,
  `playwright-runtime-security`, `chain-stack-security`,
  `test-toolchain-security`, `lint-toolchain-security`, `security-tooling`,
  and a final untyped `security-runtime` catch-all). The named security
  groups carry no `dependency-type` filter, so an advisory on an indirect
  (transitive) dependency still lands in its themed group instead of falling
  through every typed group.
- Every npm PR stays on the operator-authorized merge path. The
  [ADR 0081](0081-narrow-dependabot-auto-merge-exception.md) lane requires the
  `github_actions` ecosystem and the exact `actions-minor-patch` group, so no
  npm PR can enter it.

The two floors are separate. Dependabot's cooldown decides when a version
update may become a PR: seven days for minor and patch, 21 for major, none
for security updates. pnpm's `minimumReleaseAge` is a three-day install-time
guard on every lockfile entry not listed in `minimumReleaseAgeExclude`; it
still applies to the lockfile a Dependabot PR produces. A security PR whose
patched release is younger than three days therefore opens immediately but
fails the frozen install until that version is added to
`minimumReleaseAgeExclude`, which is the existing procedure for security
override floors.

## Alternatives considered

- **Keep npm manual.** Rejected: the work was already happening, just
  irregularly and without a boundary between risk tiers.
- **One catch-all npm group.** Rejected: a Next.js or Envio runtime bump needs
  its own verification and would block the rest of the batch.
- **Disable Dependabot security updates to stop off-Monday PRs.** Rejected:
  security PRs are the only lane that skips Dependabot's cooldown, so they
  are the earliest signal that a patched release exists. Their timing is set
  by advisory publication and cannot be scheduled.

## Consequences

- Expect up to nine grouped PRs on a Monday, plus one PR per ungrouped major
  (chain-stack majors and production majors outside the named runtime groups).
  `open-pull-requests-limit: 12` covers the common week; in a heavier week
  Dependabot defers the remainder until open PRs drop below the limit.
- Adding a package that belongs to a runtime or chain group means editing the
  group patterns and the mirrored `exclude-patterns` in the same change.
- ADR 0081's context sentence that Dependabot is limited to GitHub Actions is
  historical as of this record; its decision and lane boundary are unchanged.

## Evidence

- `.github/dependabot.yml`, `scripts/production-infra-identity-contract/workflow.test.mjs`
  (pins the unchanged `github-actions` entry),
  [`docs/pr-checklists/ci-workflow-gates.md`](../pr-checklists/ci-workflow-gates.md) §7.
- Reference setup: `mento-protocol/frontend-monorepo` `.github/dependabot.yml`.
