---
title: CI Workflow Gates Checklist
status: active
owner: eng
canonical: true
last_verified: 2026-09-01
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
- `Sentry suites` (the credential-safe Sentry regression job)

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
- [ ] **Advisory** workflows (everything _not_ in the ruleset list above) SHOULD use a workflow-level `paths:` filter so they don't boot a runner on irrelevant PRs. A skipped advisory check is simply absent — it cannot leave a _required_ check pending. This is a deliberate CI-cost control; see `lighthouse.yml`, `size-limit.yml`, and `supply-chain.yml` for the pattern. `schema-diff.yml` is a reviewed exception. It keeps its every-PR trigger so every pull request gets a visible job summary. Its in-job classifier skips irrelevant work and runs the schema diff when path detection fails.
- [ ] **Scheduled advisory** workflows SHOULD state the detection/rebuild SLO they serve and use the slowest cadence that satisfies it. Backstop monitors for multi-hour/day failure modes should prefer daily or similarly low cadence unless there is an explicit operator page-time requirement; do not default to every 15 minutes just because the check is cheap.
- [ ] If you make an advisory workflow required, add it to the ruleset **and** remove its `paths:` filter in the same change.

> ⚠️ The ruleset and these docs have drifted before: several advisory gates were written as if required (run-on-every-PR, no `paths:`) when the ruleset never enforced them. When you add or "promote" a check, update both the ruleset and this list.

### Fixed fan-out contract

Run `pnpm ci:contract:test` after a change to `ci.yml`, its fixed job set, or
the pull request validation boundary. The unconditional `Production
infrastructure contract` job runs the same command on every pull request and
`main` push.

The command checks these contracts without defining a second runtime router:

- The reviewed fixed jobs, `ci.needs`, conditional jobs, and `allowed-skips`
  have exact set equality.
- Every functional filter has positive, negative, rename, and deletion
  fixtures. Separate unknown-path and control-plane fixtures prove that those
  paths select every conditional job.
- The pinned path-filter action emits one documented count per filter. Keep the
  `all`, `routed`, and `ordinary` count comparison aligned with the functional
  filter aliases. Do not export changed-file lists.
- Pull request runs cancel stale heads. Each `main` SHA uses a distinct,
  non-cancelling concurrency group.
- Failed, cancelled, missing, unexpected, and disallowed skipped results fail
  the aggregate and name each invalid job.
- The existing pull request validation-boundary suite remains part of this
  command. It pins permissions, credential access, cache restores, cache saves,
  cleanup, and required-command ordering.
- The no-skip audit suite pins protected-main admission, exact candidate and
  base SHAs, the protected package and evidence-instrument drift comparison,
  zero skipped jobs, the retained-command boundary, cold cache policy, and
  normalized PR-only checks.

### Manual no-skip audit

`.github/workflows/no-skip-audit.yml` is the only no-skip entry point. It runs
only by manual dispatch from protected `main`. It accepts a pull request number,
full current head SHA, and full current protected-main SHA. Admission fails if
the pull request, either SHA, repository identity, base branch, or live `main`
has moved.

After the exact checkout, protected inline admission code compares the admitted
base and source Git trees. It rejects changes to package manifests, pnpm
workspace files, pnpm lockfiles, package patches, the Node and pnpm selections,
`.npmrc`, `.pnpmfile.cjs`, `pnpmfile.cjs`, and tracked `node_modules` paths.
It also rejects changes to `ci.yml`, the no-skip dispatcher, its checker and
runtime parser, both focused retained-contract definitions, and either
protected local action. The reusable audit starts only after this comparison
succeeds. Package-execution drift can use the ordinary-force-all evidence form
when the protected filter selects every retained job and every job succeeds.
Evidence-instrument drift cannot count through either evidence form. The
comparison needs no content hash registry.

Admission requires the pull request base SHA, dispatch `GITHUB_SHA`, and live
`main` SHA to be equal. An older pull request with a stale base SHA is
intentionally ineligible. Update or rebase its branch, then read fresh immutable
inputs. Treat this refusal as fail-closed admission, not a workflow failure.

The audit runs every retained deterministic CI job. It runs the focused agent
setup and package-policy contract and the focused indexer handler invariant
contract. It does not execute the legacy local-gate Bash regression suite,
routing-table suites, or indexer route parity suite. Ordinary CI keeps those
legacy steps during the post-cutover canary. The audit still runs the retained
package-script validator before dependency installation.

- [ ] Keep the dispatcher read-only. Do not forward repository or environment
      secrets. Do not use `secrets: inherit`. Called jobs still receive GitHub's
      scoped read-only `GITHUB_TOKEN`.
- [ ] Call `$/.github/workflows/ci.yml` only after admission. Keep the call job
      dependent on `admit`.
- [ ] Run the protected candidate-execution and evidence-instrument comparison
      after exact checkout and before the admission summary. Compare the
      admitted base and source objects. Do not invoke candidate code or pnpm
      during admission.
- [ ] Keep package manifests, workspace files, lockfiles, package patches, Node
      selection, pnpm configuration, and tracked `node_modules` in the
      comparison path set. Do not add a content hash registry for data already
      bound by the two Git objects.
- [ ] Keep the semantic retained `ci.yml` graph pin current. Treat any pin
      update as an explicit target change during the evidence window.
- [ ] Keep audit inputs limited to `ci.yml` and the protected dispatcher. Do not
      add a second workflow caller that can bypass admission.
- [ ] In audit mode, skip checkout and `dorny/paths-filter` in `changes`. The
      protected workflow must set `forceAll`; it must not resolve a mutable branch.
- [ ] Every candidate-executing job must check out the admitted source SHA with
      full history and `persist-credentials: false`.
- [ ] Resolve CI-owned local actions with `$/.github/actions/...`. The `$` form
      uses the running protected commit and does not need a candidate checkout.
- [ ] Pass the admitted base through step `env` for shell commands. Quote the
      variable in the command. Do not interpolate a dispatch input inside `run`.
- [ ] Disable persistent cache reads and writes in the cold audit. This includes
      every reviewed pnpm, Playwright, Foundry, and Turbo restore, save, and post
      hook. GitHub exposes cache-service authority outside `permissions`; the
      trusted same-repository candidate remains inside the accepted threat model.
- [ ] Skip Codecov, UI failure artifacts, and timeline actions in audit mode.
- [ ] Use the separate audit aggregate with no `allowed-skips`. Keep the normal
      pull request aggregate and its reviewed conditional skips unchanged.
- [ ] Keep the exact legacy local-gate steps conditional on
      `!inputs.no_skip_audit`. Do not exclude a retained package, policy, trust,
      documentation, browser, build, generation, or test command.
- [ ] Reject package-execution path drift during the evidence window. Ordinary
      CI remains the validation path for package, dependency, and toolchain PRs.
- [ ] Reject evidence-instrument drift during admission. Protect `ci.yml`, the
      dispatcher, the no-skip checker and runtime parser, both focused contract
      definitions, and both protected local action trees. Do not count
      instrument-changing pull requests.
- [ ] Keep every package-execution admission path family in the ordinary
      `controlPlane` filter. A qualifying ordinary-force-all proof must run
      every retained job to success.
- [ ] Keep the focused setup/package-policy and indexer handler invariant
      steps exact, unconditional, and blocking in audit mode.
- [ ] Keep the audit step-skip allowlist closed. Every retained command must
      execute and remain blocking. Reject equivalent legacy entry points.
- [ ] Keep both routing-table suite invocations outside the retained target.
      Their assertions test the legacy selector. Fixed CI runs the retained
      generated-output and workflow safeguards that the selector also routes.
- [ ] Keep the same-repository candidate inside the accepted threat model. The
      audit controls workflow selection and package execution configuration. It
      does not sandbox deliberate process creation inside retained candidate
      product, test, or dependency code.
- [ ] Do not add a schedule until the eligible cold proof passes. Stop after a
      run exceeds 45 runner-minutes. Do not exceed 450 cumulative runner-minutes.

Run `pnpm ci:contract:test` after any change to these facts. Do not dispatch the
audit from an implementation pull request. The first eligible cold proof runs
after the workflow reaches protected `main`.

## 2. Branch enforcement on `workflow_dispatch`

`workflow_dispatch` lets any maintainer with write access trigger a workflow from any branch. For deploy workflows, this bypasses the trust-main quality gate.

- [ ] Every deploy job MUST include `if: github.ref == 'refs/heads/main'` (or equivalent environment guard) at the job level
- [ ] Don't rely on the `push.branches: [main]` filter alone — `workflow_dispatch` doesn't honor it

Canonical good example: the `deploy` job guard in
`.github/workflows/metrics-bridge.yml`.

## 3. Pinning third-party actions

A `uses: org/action@v4` line trusts whoever owns that tag to never re-point it at malicious code. Tags are mutable; commit SHAs are not.

- [ ] All third-party actions in workflows and composite actions MUST be pinned to a full commit SHA with the tag in a comment: `uses: org/action@<40-char-sha> # v6.0.2`
- [ ] Self-repository actions such as `uses: $/.github/actions/pnpm-install` and local relative actions such as `uses: ./.github/actions/pnpm-install` are allowed. Use `$` when the action must come from the running protected commit. Use `./` when the checked-out source intentionally owns the action. The scanner follows either target and checks nested third-party `uses:` entries too.
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
- **Third-party GitHub Actions:** require an operator-authorized merge. This includes
  load-bearing gates such as `re-actors/alls-green` and credential actions
  such as `google-github-actions/auth`.
- **Major:** require human review and an operator-authorized merge. Check action input/output
  changes and ESM-only migrations that can skip dependents. Use `@codex review`
  for a second opinion.
- **Maintainer changes:** require an operator-authorized merge at every tier.
- **Security advisories:** bypass cooldown and stay outside the named routine
  group. Require an operator-authorized merge.
- **`actions/create-github-app-token`:** require an operator-authorized merge. This action can
  mint GitHub App installation tokens. Keep credential tooling outside the lane
  so it cannot change an authentication boundary by itself.
- **`anthropics/*`:** require an operator-authorized merge. These actions participate in the
  review boundary and remain separate from other third-party groups.
- **`dependabot/*`:** require an operator-authorized merge. `dependabot/fetch-metadata`
  classifies this auto-merge lane, so it cannot update itself through the lane.
  Dependabot-owned actions remain separate from other third-party groups.
- **Every non-GitHub-Actions ecosystem:** require an operator-authorized merge.

All version-update tiers use `default-days: 7`; the `github-actions` ecosystem
has no per-tier cooldown. GitHub skips cooldown for security updates. Requiring
the exact `actions-minor-patch` dependency group and `actions/*` publisher
boundary keep those immediate security updates outside auto-merge.

The lane has two pinned workflows. The `pull_request` classifier has read-only
permissions. It verifies the event and pinned Dependabot metadata. The
default-branch `workflow_run` writer treats completion as an untrusted signal.
It re-reads the exact workflow and run, first-attempt job and step results,
current PR and head, the complete issue-event close history, the current PR
body's exact `Maintainer changes` marker, every commit, every changed file, and
the base's merge queue. It requires one open same-repository PR, no prior
`closed` or `reopened` event, verified Dependabot-authored commits, and only
modified top-level workflow YAML. A recorded close remains a durable human veto
after the same PR and head are reopened. Dependabot must open a new PR before
the update can enter this lane again. The writer always rejects changes to
either trust workflow. It waits for every required check and verifies a
non-empty passing required-only projection. It then repeats the complete
workflow, run, job, PR, head, maintainer-change body, close-history, commit,
file, and queue proof. The issue-event read is the final authoritative read.
The final write is a synchronous REST merge with the exact head SHA and squash
method. It cannot enqueue, create an auto-merge request, or pin issue-event
history. A close and reopen inside the remaining request window is a residual
race. Neither workflow checks out or executes PR code. The writer does not read
upstream outputs, artifacts, or caches. `pnpm tf:test` pins both parsed workflow
shapes. The autofix trust checker rejects every `pull_request_target` workflow.

Before changing the classifier policy or successful job shape, drain every
in-flight run from the prior classifier version or add an explicit runtime
version binding. The writer uses the stable workflow ID and path. Those values
alone do not distinguish old classifier source from new classifier source.

The automatic `GITHUB_TOKEN` merge does not emit this repository's `push`
workflows. Required PR checks are the final automated evidence for this narrow
lane. The writer refuses if `main` has a merge queue. The final REST endpoint
has no enqueue behavior, so a queue activated after the last read cannot turn
the write into deferred queue state. A future queue rollout must still keep
this lane disabled until a reviewed design defines its queue behavior. The
repository accepts the built-in token's residual risk for this bounded routine
group. `GH_READ_TOKEN` and `FINAL_MERGE_TOKEN` both resolve to `github.token` by
design. Keep the variables separate so tests can prove that all evidence reads
use the read seam and only the synchronous exact-head REST request uses the
final-write seam. Issue #2091 was closed as not planned. This lane will not add a
`merge-operators` Team, credential broker, dedicated merge App, protected merge
Environment, or controlled lifecycle ruleset.

- [ ] If you add a new external review integration — GitHub App or Action — that is load-bearing for review or merge gating, keep its updates outside routine groups when an isolated review improves the self-update boundary
- [ ] If you add a new `package-ecosystem` to `dependabot.yml`, keep it on the
      operator-authorized path unless a separate reviewed decision defines its exact lane.
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
