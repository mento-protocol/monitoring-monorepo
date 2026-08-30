---
title: CI Workflow Gates Checklist
status: active
owner: eng
canonical: true
last_verified: 2026-08-30
doc_type: checklist
scope: ci/process
review_interval_days: 90
garden_lane: pr-checklists-process
---

# CI workflow gates checklist

Use this checklist for any change to `.github/workflows/`. CI mistakes don't surface until the next merge — and by then the bad pattern is already shipped to other workflows by copy-paste.

## Operating rule

> **Required-status workflows must always run, must run from a known branch, and must trust only pinned, verifiable third-party code.**

## 1. Required-status checks and `paths:` filters

GitHub treats a "required" check as:

- "satisfied" if it ran and passed
- "pending" if it ran and is in progress
- "pending" (forever, blocking the merge) if it never ran at all

**Adding a `paths:` filter to a _required_ workflow is a footgun.** PRs that don't touch the matched paths skip the workflow entirely and the check stays pending forever, silently blocking unrelated merges.

The word "required" means **enforced by the `main` branch ruleset**, not "feels important". The ruleset currently requires exactly:

- `ci` (the CI sentinel job)
- `Code Quality` (the Trunk workflow's job)
- `Vercel` and `Vercel Preview Comments` (the Vercel platform)

Verify the live list before relying on this:

```
gh api repos/mento-protocol/monitoring-monorepo/rulesets \
  -q '.[] | select(.target=="branch").id' \
| xargs -I{} gh api repos/mento-protocol/monitoring-monorepo/rulesets/{} \
  -q '.rules[] | select(.type=="required_status_checks").parameters.required_status_checks[].context'
```

After changing a required-status workflow or replacing the tool that reports its
checks, verify the live PR status rollup with
`pnpm pr:ready-state --pr <number> --json`. Confirm the intended required
context is the only tool-owned check GitHub surfaces. PR #1008/#1010 exposed the
failure mode: an action-created `Trunk Check` Checks API run appeared alongside
the intended `Code Quality` job, and GitHub grouped the extra failure under the
advisory schema-diff workflow in the PR UI.

- [ ] **Ruleset-required** workflows MUST NOT use `paths:` / `paths-ignore:` filters — they must run on every PR. If you want path-conditional work, run every PR but skip the expensive job inside via `if:` checks (or `paths-filter`-style gating that reports a green check on no-op).
- [ ] Registry-backed Terraform routing uses the broad `workflowAdmissionPatterns` list in `terraform.stacks.json`. Keep the required CI workflow unfiltered at workflow level. Its internal `terraform` filter and the Infra push/pull-request filters copy that list. Do not enumerate stack-specific paths in those filters. `pnpm tf:test` enforces exact equality and proves that the boundary subsumes every `changedPathPatterns` entry.
- [ ] **Advisory** workflows (everything _not_ in the ruleset list above) SHOULD use a workflow-level `paths:` filter so they don't boot a runner on irrelevant PRs. A skipped advisory check is simply absent — it cannot leave a _required_ check pending. This is a deliberate CI-cost control; see `lighthouse.yml`, `size-limit.yml`, and `supply-chain.yml` for the pattern. **M2 exception:** `schema-diff.yml` keeps its existing every-PR trigger during credential and cache hardening. It routes in-job, fails closed on path-filter errors, and publishes only a read-only job summary. Reconsider its trigger in the fixed-coverage phase; do not change it incidentally.
- [ ] **Scheduled advisory** workflows SHOULD state the detection/rebuild SLO they serve and use the slowest cadence that satisfies it. Backstop monitors for multi-hour/day failure modes should prefer daily or similarly low cadence unless there is an explicit operator page-time requirement; do not default to every 15 minutes just because the check is cheap.
- [ ] If you make an advisory workflow required, add it to the ruleset **and** remove its `paths:` filter in the same change.

> ⚠️ The ruleset and these docs have drifted before: several advisory gates were written as if required (run-on-every-PR, no `paths:`) when the ruleset never enforced them. When you add or "promote" a check, update both the ruleset and this list.

## 2. Branch enforcement on `workflow_dispatch`

`workflow_dispatch` lets any maintainer with write access trigger a workflow from any branch. For deploy workflows, this bypasses the trust-main quality gate.

- [ ] Every deploy job MUST include `if: github.ref == 'refs/heads/main'` (or equivalent environment guard) at the job level
- [ ] Don't rely on the `push.branches: [main]` filter alone — `workflow_dispatch` doesn't honor it

Canonical good example: the `deploy` job guard in
`.github/workflows/metrics-bridge.yml`.

## 3. Pinning third-party actions

A `uses: org/action@v4` line trusts whoever owns that tag to never re-point it at malicious code. Tags are mutable; commit SHAs are not.

- [ ] All third-party actions in workflows and composite actions MUST be pinned to a full commit SHA with the tag in a comment: `uses: org/action@<40-char-sha> # v6.0.2`
- [ ] Local relative actions such as `uses: ./.github/actions/pnpm-install` are allowed; the scanner follows their `action.yml` / `action.yaml` targets and checks nested third-party `uses:` entries too.
- [ ] Run `node scripts/workflows/check-github-action-pins.mjs` locally when editing `.github/workflows/**`, `.github/actions/**`, or `.trunk/setup-ci/**`; the required `Code Quality` workflow runs the same check on every PR.

Canonical good example: `.github/workflows/metrics-bridge.yml` — every external
action is SHA-pinned.

## 4. Concurrency and serialization

- [ ] Deploy workflows MUST set a concurrency group that serializes ALL invocations against the same target (e.g. `group: ${{ github.workflow }}`, with `cancel-in-progress: false`). Two close main-merges racing on `gcloud run services update` can otherwise stomp each other
- [ ] Non-deploy workflows MAY use a per-ref concurrency group with `cancel-in-progress: true` to drop stale runs on force-push

Canonical good example: the workflow-level `concurrency` block in
`.github/workflows/metrics-bridge.yml`.

## 5. Cache trust and keys

A cache crosses commit and workflow boundaries. Treat restore authority, save
authority, and key inputs as separate controls.

- [ ] Every PR-reachable `actions/setup-node` step MUST set `package-manager-cache: false`. Its implicit cache post-step can save data. Use explicit split restore and save actions instead.
- [ ] Pull request jobs MAY restore disposable setup caches with `actions/cache/restore`. The restore must use a `trusted-main-v1-*` namespace populated by protected `main` and set `continue-on-error: true`. If `cache-hit` is empty, remove only the fixed cache target before the required setup command. This clears a miss or failed partial extraction. Keep a complete prefix-key restore, whose `cache-hit` output is `false`, and still run the command. Pull request jobs MUST NOT use `actions/cache` or `actions/cache/save`.
- [ ] A cache save MUST use `actions/cache/save`, use the same `trusted-main-v1-*` namespace, and require both `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`. Keep saves nonfatal. A caller input alone never authorizes a save.
- [ ] A cache hit MUST NOT skip install, lint, typecheck, test, build, code generation, or generated-output comparison. Caches accelerate setup only. Every required command runs on every invocation.
- [ ] If the workflow runs codegen (e.g. `pnpm indexer:codegen`, `pnpm dashboard:codegen`), execute it on every invocation. Include every codegen input in any disposable setup-cache key. This includes scripts, config, schemas, and ABIs. If output is committed, verify it with `git status --porcelain -- <path>` so untracked generated files fail too.
- [ ] Lockfile (`pnpm-lock.yaml`) is necessary but NOT sufficient — codegen output depends on more than dep versions
- [ ] pnpm patch files under `patches/**` are package-manager inputs. Patch-only PRs MUST trigger frozen install and package quality paths, because `pnpm-lock.yaml` records patch hashes and a stale or missing patch hash fails frozen install.
- [ ] For caches of **external binaries whose version is resolved transitively** (Playwright Chromium under `~/.cache/ms-playwright`, Cypress browsers under `~/.cache/Cypress`, etc.), the cache key MUST include `pnpm-lock.yaml`, not only `package.json`. A lockfile-only dependency update can change the required binary revision. Use a same-namespace `restore-keys:` fallback for near matches. The protected-main save then writes the exact new key after setup completes.

- [ ] If a cache stores **architecture-specific binaries** (Playwright Chromium, trunk's `~/.cache/trunk` tool dir), the key MUST include `${{ runner.arch }}`. Installers can validate a version but miss an architecture mismatch. A cross-architecture restore then fails at execution. A text-only cache does not need an architecture component, but it must still use the trusted namespace and must never replace a required command.

## 6. Fail-closed audit / security workflows

Audit workflows that "tolerate transient errors" become attack surface — an attacker who can wedge the registry can ship malicious deps during the outage window.

- [ ] Audit workflows MUST fail-closed on registry errors. Don't pass `--ignore-registry-errors` or equivalent
- [ ] High-advisory exceptions MUST be implemented as parsed-audit filters scoped
      by advisory ID, package, resolved version, and exact dependency path. Do not
      use broad `pnpm audit --ignore` rules for PR gates. Add fixture coverage for
      the allowed path and a sibling disallowed path.
- [ ] If a path-scoped audit gate replaces a required Trunk/OSV lockfile scan,
      run that replacement in a ruleset-required check such as Code Quality.
- [ ] If you genuinely need a soft-failure path, gate it behind a manual `workflow_dispatch` with explicit input, not on every PR

## 7. Dependabot policy

Dependabot is scoped to the `github-actions` ecosystem (`.github/dependabot.yml`). npm is handled by pnpm with `minimumReleaseAge: 4320` in `pnpm-workspace.yaml`; GitHub-issued security advisories on `pnpm-lock.yaml` still come through as Dependabot PRs without an `npm` entry.

Dependabot groups routine updates. One exact group can auto-merge through
`.github/workflows/dependabot-auto-merge.yml`.

- **GitHub-owned `actions/*` patch / minor in `actions-minor-patch`:**
  auto-merge after required checks pass.
- **Third-party GitHub Actions:** require a human merge. This includes
  load-bearing gates such as `re-actors/alls-green` and credential actions
  such as `google-github-actions/auth`.
- **Major:** require human review and a human merge. Check action input/output
  changes and ESM-only migrations that can skip dependents. Use `@codex review`
  for a second opinion.
- **Maintainer changes:** require a human merge at every tier.
- **Security advisories:** bypass cooldown and stay outside the named routine
  group. Require a human merge.
- **`actions/create-github-app-token`:** require a human merge. Issue #2091
  uses it to mint the dedicated merge credential, so it cannot update through
  the lane whose credential boundary it creates.
- **`anthropics/*`:** require a human merge. These actions participate in the
  review boundary and remain separate from other third-party groups.
- **`dependabot/*`:** require a human merge. `dependabot/fetch-metadata`
  classifies this auto-merge lane, so it cannot update itself through the lane.
  Dependabot-owned actions remain separate from other third-party groups.
- **Every non-GitHub-Actions ecosystem:** require a human merge.

All version-update tiers use `default-days: 7`; the `github-actions` ecosystem
has no per-tier cooldown. GitHub skips cooldown for security updates. Requiring
the exact `actions-minor-patch` dependency group and `actions/*` publisher
boundary keep those immediate security updates outside auto-merge.

The lane has two pinned workflows. The `pull_request` classifier has read-only
permissions. It verifies the event and pinned Dependabot metadata. The
default-branch `workflow_run` writer treats completion as an untrusted signal.
It re-reads the exact workflow and run, first-attempt job and step results,
current PR and head, every commit, and every changed file. It requires one open
same-repository PR, verified Dependabot-authored commits, and only modified
top-level workflow YAML. It always rejects changes to either trust workflow.
It then passes the checked head to `gh pr merge --match-head-commit`. Neither
workflow checks out or executes PR code. The writer does not read upstream
outputs, artifacts, or caches. `pnpm tf:test` pins both parsed workflow shapes.
The autofix trust checker rejects every `pull_request_target` workflow.

Before changing the classifier policy or successful job shape, drain every
in-flight run from the prior classifier version or add an explicit runtime
version binding. The writer uses the stable workflow ID and path. Those values
alone do not distinguish old classifier source from new classifier source.

This lane enables GitHub auto-merge before every required check has finished.
It therefore creates a standing request by design. The synchronous REST rule in
the human merge wrapper does not apply. The automatic `GITHUB_TOKEN` merge also
does not emit this repository's `push` workflows. Required PR checks are the
final automated evidence for this narrow lane. The writer refuses if `main`
has a merge queue. A future queue rollout must keep this lane disabled until a
new reviewed design defines its queue behavior. Before issue #2091 activates
its lifecycle ruleset, it must migrate the final writer from `GITHUB_TOKEN` to
a dedicated repository-scoped merge App token sourced by the trusted
default-branch writer from IaC-owned repository Actions secrets. It must also
prove the App credentials are enabled, the migration is verified, and legacy
auto-merge state is drained. Do not give the shared GitHub Actions App identity
a ruleset bypass.

- [ ] If you add a new external review integration — GitHub App or Action — that is load-bearing for review or merge gating, keep its updates outside routine groups when an isolated review improves the self-update boundary
- [ ] If you add a new `package-ecosystem` to `dependabot.yml`, keep it on the
      human path unless a separate reviewed decision defines its exact lane.
      npm has a larger transitive blast radius than GitHub Actions.

## 8. Runner architecture (ARM vs x64)

Blacksmith ARM runners (`blacksmith-{2,4}vcpu-ubuntu-2404-arm`) bill at 0.625× the x64 per-minute rate — but they are **not** automatically cheaper. Measured on this repo (compat PR #821, two full sweeps cold + warm, June 2026):

- **CPU-bound node jobs run ~2–3.4× slower on ARM** (ui browser tests 7m34s vs 2m13s, indexer vitest 4m09s vs 2m00s, shared 1m08s vs 0m33s). This is per-core throughput, not a cold-cache artifact.
- **Network-bound jobs run at parity** (terraform init/plan/apply, gcloud deploys, RPC-driven probes: 1m03s vs 1m02s).
- With per-job **round-up billing**, the break-even runtime ratio is **1.6×** (price ratio 0.625). A job that crosses one extra billed-minute boundary on ARM costs _more_ despite the cheaper rate.

Decision framework for `runs-on` (applied in PR #822 — partial migration saving ≈$10/mo; the blanket migration would have _added_ ≈$36/mo):

- [ ] **Network/IO-bound job** (terraform, gcloud, curl-driven, external-API polling) → ARM. Runtime is parity; the 37.5% rate cut is pure savings.
- [ ] **Sub-minute on both architectures** (paths-filter `changes` detectors, format checks, lockfile lint) → ARM. Both bill 1 minute; rate cut is pure savings.
- [ ] **CPU-bound hot-path job** (vitest/typecheck/lint suites, Next builds,
      browser tests) → **x64** when the measured ARM slowdown crosses billing
      boundaries or materially delays PR feedback. The weekly, bounded Stryker
      jobs are a measured exception and currently run on ARM; remeasure before
      changing that workflow.
- [ ] **Anything launching Chrome via chrome-launcher/puppeteer/lhci** → x64, hard requirement: Google publishes no Chrome for linux-arm64. (Playwright's own Chromium DOES ship arm64 — only Chrome-dependent tooling is blocked.)
- [ ] Jobs that generate artifacts consumed by another job (`update-snapshots.yml` baselines ↔ ci.yml `ui` snapshot assertions) MUST stay on the same architecture as their consumer.
- [ ] Before migrating any job class, **measure** warm runtime on the target arch (throwaway PR with two pushes — cold then warm caches; `workflow_dispatch` for cron workflows) and compare the ratio against 1.6×. Don't extrapolate from the price sheet.
- [ ] New ARM labels go into BOTH actionlint allow-lists (`.github/actionlint.yaml` + `.trunk/configs/actionlint.yaml`), and binary caches get arch-keyed (see §5).

## 9. Notifier coverage — keeping Slack alerts wired

`notify-slack-on-main-failure.yml` fires for every workflow whose failure would otherwise be silent. It must be kept in sync whenever a new workflow is added.

- [ ] If the new workflow runs on push to `main` (`on.push.branches: [main]`, OR a branchless `on.push:` with no `branches:`/`branches-ignore:` key, which runs on every branch) OR has `on.schedule`, add its `name:` value to the `workflow_run.workflows` list in `notify-slack-on-main-failure.yml`
- [ ] If it's intentionally advisory/non-blocking and you don't want Slack noise on flakes, add its `name:` value to the `EXCLUDED_NAMES` set in `scripts/workflows/check-notifier-coverage.mjs` with a comment explaining why
- [ ] `node scripts/workflows/check-notifier-coverage.mjs` must pass after the change — it runs in the `scripts` CI job and enforces this structurally. The `scripts` job's `rootScripts` path filter includes `.github/workflows/**`, so adding a workflow file alone is enough to fire the check (no script edit required)

`workflow_run.workflows` does NOT support wildcards — every new workflow name must be listed explicitly.

## 10. Autofix CI trust boundary — machine-authored PRs are untrusted

Sentry-autofix PRs (head branch `sentry-autofix/*`) are same-repo, non-fork,
non-Dependabot — they pass every historical CI trust check — but their diffs
are machine-authored from untrusted Sentry input, so any secret a `pull_request`
job exposes to their PR-head code is an exfiltration channel (issue #1388).
`scripts/workflows/check-autofix-ci-trust.mjs` enforces this structurally in the
`scripts` CI job. It parses the workflow with `js-yaml` and analyzes the parsed
structure, so exotic-but-valid YAML (anchors, `\uXXXX` escapes, block scalars,
flow/JSON roots) cannot slip a trigger or secret past it; unparsable YAML fails
closed.

- [ ] The trust boundary covers every way an autofix branch is REACHABLE, not just `pull_request`: the eventual PR (`pull_request`), the `push` the finalizer makes to `sentry-autofix/*` before the PR exists (when the workflow's `branches:`/`branches-ignore:` filter admits that branch — a `branches: [main]` or tags-only push does not), and that branch's `create` event. A credential-bearing job reachable via a context must exclude it on the job's `if:` for THAT context — `!startsWith(github.event.pull_request.head.ref, 'sentry-autofix/')` for pull_request; `!startsWith(github.ref, 'refs/heads/sentry-autofix/')` (or `github.ref_name`, `'sentry-autofix/'`) for push/create — or carry an `# autofix-ci-trust: <why unreachable>` annotation. A job annotation must be a genuine comment INSIDE that job's body (indented deeper than the job key); a comment above `jobs:` is file-level and covers every job. The checker is per-job: one guarded job does not vouch for an unguarded sibling
- [ ] "Credential-bearing" is broader than `${{ secrets.* }}`. It also covers: a
      job bound to a GitHub `environment:`; `id-token: write` (this repo's WIF
      pool trusts any OIDC token from this repository — `terraform/ci-wif.tf` —
      so the permission alone exchanges into the plan-readonly service account)
      or `permissions: write-all`; a **write-scoped `${{ github.token }}`** (its
      effective permissions grant any `write` scope); a reusable-workflow
      `secrets:` forward; and a call to an **in-repo reusable workflow**
      (`uses: ./.github/workflows/…` or the fully-qualified
      `mento-protocol/monitoring-monorepo/.github/workflows/…@ref`), whose
      callee may bind a credential the caller cannot see. All need the same
      guard or annotation
- [ ] Do not introduce `pull_request_target`. The checker refuses every use.
      Use an unprivileged PR classifier and a default-branch writer only after
      a separate reviewed decision defines the full boundary.
- [ ] Checkouts in jobs that execute PR-head code set `persist-credentials: false` (the checkout token in `.git/config` is readable by any test/build the PR controls)
- [ ] `node scripts/workflows/check-autofix-ci-trust.mjs` must pass after the change
- [ ] `node scripts/workflows/check-pr-validation-boundary.test.mjs` must pass
      after a permission, cache, Codecov, schema-diff, or Dependabot workflow
      change. It pins the closed write and credential job inventories, exact
      permission maps, credential bindings, environments, forwarded secrets,
      and reusable targets. It follows local reusable workflows. It scans
      every cache save. It also pins each retained restore, targeted cleanup,
      and required command.

## 11. Lessons already paid for

- PR #188 — consolidating per-package CI workflows nearly removed the push-to-main guard on the metrics-bridge deploy and the workflow_dispatch branch check
- PR #191 — `paths:` filter on the supply-chain workflow would have made the required check skip on PRs that don't touch deps, blocking unrelated merges
- PR #191 — third-party actions weren't all SHA-pinned, leaving a supply-chain trust gap
- PR #188 — caching key for indexer codegen missed the codegen scripts; cached output went stale on script-only changes
- PR #186 — workflow path filter for "bridge changes" missed the workflow file itself, so workflow edits didn't re-run
- PR #821/#822 — "ARM is 37.5% cheaper" was falsified for CPU-bound jobs: ~2–3.4× slower runtime + round-up billing made them MORE expensive on ARM; only network-bound and sub-minute jobs migrated. Also: Trunk's `~/.cache/trunk` stores architecture-specific binaries — cross-arch restore caused `execve failed: Text file busy`, so the Code Quality cache key includes `${{ runner.arch }}`
