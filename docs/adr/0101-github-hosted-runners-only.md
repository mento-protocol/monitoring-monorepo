---
title: GitHub-hosted runners only; a frozen allow-list blocks other labels
status: active
owner: eng
canonical: true
last_verified: 2026-09-15
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0101 — GitHub-hosted runners only; a frozen allow-list blocks other labels

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

Every CI, Infra, Trunk, Schema Diff, Supply Chain, and Lighthouse job ran on a
paid Blacksmith runner (`blacksmith-*-ubuntu-2404[-arm]`), billing
$203-344/month, on a public repository where GitHub-hosted `ubuntu-latest` and
`ubuntu-24.04-arm` are free and unlimited. Nothing stopped a future workflow
from introducing an unreviewed runner label: there was no allow-list, and no
assertion kept the two actionlint self-hosted-runner allow-lists
(`.github/actionlint.yaml`, `.trunk/configs/actionlint.yaml`) in sync. #2373
proposed a different direction for the same cost problem (a self-hosted
`sol-ci` runner pool); the operator closed #2373 in favor of this migration
(decision 2026-09-14) after confirming the org has no static egress IP and no
third-party allowlist depends on a runner IP.

## Decision

Move every `runs-on:` site from a `blacksmith-*` label to a free GitHub-hosted
one: `ubuntu-latest` (x64) for any job that calls the shared `pnpm-install`
composite or otherwise runs a real `pnpm install`, so it matches the
pnpm-store cache writer's (`production-infra-contract`) architecture instead
of taking a permanent cross-arch cache miss; `ubuntu-24.04-arm` for jobs that
never install pnpm. Freeze the result with `ALLOWED_RUNNER_LABELS` in
`scripts/workflows/check-ci-contract.mjs`: a negative control that walks
every `.github/workflows/*.yml` job's `runs-on` and fails closed (on an
unparsable file, a missing top-level mapping, or a label outside the set) on
anything other than exactly `ubuntu-latest` or `ubuntu-24.04-arm`, plus an
assertion that `.github/actionlint.yaml` and `.trunk/configs/actionlint.yaml`
stay byte-identical (both now empty, since no runner label needs a
self-hosted acknowledgement). A future workflow proposing any other runner
class — a paid GitHub tier, a self-hosted pool, or Blacksmith again — fails
this check until it also updates the allow-list, which requires touching this
ADR.

## Alternatives considered

- **Keep Blacksmith runners.** Rejected: $203-344/month for jobs GitHub
  already runs free on a public repository, with no throughput advantage
  demonstrated by this PR's measurement (13 of 14 sampled jobs ran at or
  faster than Blacksmith's measured p50 on the free hosted tier).
- **#2373's self-hosted `sol-ci` runner pool.** Rejected by the operator
  2026-09-14 in favor of this PR: a self-hosted pool avoids both the
  Blacksmith bill and any hosted-runner limits, but trades that for ongoing
  fleet operation and patching, which the operator judged not worth it once
  the free hosted tier's measured performance was in evidence.
- **GitHub's paid, larger hosted runners** (for example a 4-core
  `ubuntu-latest` variant). Rejected: the free tier already matches or beats
  Blacksmith's measured job durations, so there is no demonstrated need to
  pay for more.
- **No allow-list; rely on code review to catch a stray future label.**
  Rejected: review is exactly the layer that let 57 Blacksmith sites
  accumulate with no structural gate in the first place, and a
  comment-only convention has no enforcement when it is forgotten. The fix
  is a CI-time negative control, not a checklist line.

## Consequences

- A workflow PR that introduces a `runs-on` label outside `ubuntu-latest` /
  `ubuntu-24.04-arm` fails `check-ci-contract.mjs` inside the required `ci`
  sentinel. Adopting a different runner class again means editing this ADR
  (superseding it, per the process this ADR itself is filed under) and
  `ALLOWED_RUNNER_LABELS` together, not just the workflow file.
- `.github/actionlint.yaml` and `.trunk/configs/actionlint.yaml` stay empty
  and byte-identical; a future self-hosted label (which actionlint requires
  acknowledging by name) must add to both files in the same PR that widens
  `ALLOWED_RUNNER_LABELS`, or the byte-identical assertion fails.
- Every job that calls the `pnpm-install` composite now runs on the cache
  writer's architecture (x64), removing the permanent ARM64 cache-miss that
  `continue-on-error: true` previously hid.
- Lighthouse's Chrome launch needed a follow-up fix on the migrated
  `ubuntu-24.04` image: Ubuntu 23.10+ restricts unprivileged user namespaces
  under AppArmor unless the launching binary ships its own profile, which the
  Playwright-downloaded Chromium this audit uses does not. `lighthouse.yml`
  clears `kernel.apparmor_restrict_unprivileged_userns` in a step before
  Chrome launches, keeping Chrome's own sandbox on rather than adding
  `--no-sandbox`.

## Evidence

- `scripts/workflows/check-ci-contract.mjs`'s `ALLOWED_RUNNER_LABELS` and
  `runnerLabelViolations`, exercised by `check-ci-contract.test.mjs`
  (fail-closed YAML-parse-error case, sequence/`self-hosted`-selector
  rejection, reusable-workflow-call skip, actionlint byte-identical check).
- PR [#2413](https://github.com/mento-protocol/monitoring-monorepo/pull/2413)'s
  `## Validation` measurement table and Lighthouse Chrome-sandbox fix.
- Issue [#2400](https://github.com/mento-protocol/monitoring-monorepo/issues/2400).
