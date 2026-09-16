---
title: CI Workflow Gates Checklist
status: active
owner: eng
canonical: true
last_verified: 2026-09-14
doc_type: checklist
scope: ci/process
review_interval_days: 90
garden_lane: pr-checklists-process
---

# CI workflow gates checklist

Use this checklist for any change to `.github/workflows/`. CI mistakes don't surface until the next merge — by then the bad pattern is already copy-pasted elsewhere.

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

After changing a required-status workflow or its reporting tool, verify the
live PR status rollup with `pnpm pr:ready-state --pr <number> --json` and
confirm GitHub surfaces only the intended check. PR #1008/#1010: an
action-created `Trunk Check` run appeared beside `Code Quality`, grouped under
the advisory schema-diff workflow.

- [ ] **Ruleset-required** workflows MUST NOT use `paths:` / `paths-ignore:` filters — they must run on every PR. If you want path-conditional work, run every PR but skip the expensive job inside via `if:` checks (or `paths-filter`-style gating that reports a green check on no-op).
- [ ] Registry-backed Terraform routing uses the `workflowAdmissionPatterns` list in `terraform.stacks.json`. Keep the required CI workflow unfiltered at workflow level. Its internal `terraform` filter copies that list. Prefer a top-level boundary; register a nested entry in `NESTED_ADMISSION_EXCEPTIONS`. `pnpm tf:test` enforces exact equality and subsumption of every registry pattern.
- [ ] **Advisory** workflows (everything _not_ in the ruleset list above) SHOULD use a workflow-level `paths:` filter so they don't boot a runner on irrelevant PRs. A skipped advisory check is simply absent — it cannot leave a _required_ check pending. This is a deliberate CI-cost control; see `lighthouse.yml`, `size-limit.yml`, and `supply-chain.yml` for the pattern. `schema-diff.yml` is a reviewed exception. It keeps its every-PR trigger so every pull request gets a visible job summary. Its in-job classifier skips irrelevant work and runs the schema diff when path detection fails.
- [ ] **Scheduled advisory** workflows SHOULD state the detection/rebuild SLO they serve and use the slowest cadence that satisfies it. Backstop monitors for multi-hour/day failure modes should prefer daily or similarly low cadence unless there is an explicit operator page-time requirement; do not default to every 15 minutes just because the check is cheap.
- [ ] If you make an advisory workflow required, add it to the ruleset **and** remove its `paths:` filter in the same change.

> ⚠️ The ruleset and these docs have drifted before: advisory gates were written as if required (run-on-every-PR, no `paths:`) when the ruleset never enforced them. Update both the ruleset and this list when you add or "promote" a check.

### Fixed fan-out contract

Run `pnpm ci:contract:test` after a change to `ci.yml`, its fixed job set, or
the validation boundary. The unconditional `Production infrastructure
contract` job runs it on every PR and `main` push.

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

### No-skip audit

`.github/workflows/no-skip-audit.yml` is the only no-skip entry point. It runs
by dispatch from protected `main`. It accepts a pull request number,
full current head SHA, and full current protected-main SHA. Admission fails if
the pull request, either SHA, repository identity, base branch, or live `main`
has moved.

M6 collection and recovery are retired; historical evidence is linked from ADR 0101.

After the exact checkout, protected inline admission code compares the admitted
base and source Git trees, and the reusable audit starts only once that
comparison succeeds. It rejects changes to package manifests, pnpm workspace
files, pnpm lockfiles, package patches, the Node and pnpm selections, `.npmrc`,
`.pnpmfile.cjs`, `pnpmfile.cjs`, tracked `node_modules` paths, `ci.yml`, the
no-skip dispatcher, the CI contract source and test entry point, the no-skip
checker and runtime parser, both focused retained-contract definitions, and
either protected local action. Package-execution drift can use the
ordinary-force-all evidence form when the protected filter selects every
retained job and every job succeeds. Evidence-instrument drift cannot count
through either evidence form. The comparison needs no content hash registry.

Admission requires the pull request base SHA, dispatch `GITHUB_SHA`, and live
`main` SHA to be equal. An older pull request with a stale base SHA is
intentionally ineligible. Update or rebase its branch, then read fresh immutable
inputs. Treat this refusal as fail-closed admission, not a workflow failure.

The audit runs every retained deterministic CI job, including the focused agent
setup and package-policy contract, indexer handler invariant contract, and
dependency-cruiser root contract. It still runs the retained package-script
validator before dependency installation. Neither ordinary CI nor the audit
executes the legacy local-gate Bash regression suite, and the legacy
routing-table and indexer route parity suites are retired in both.

- [ ] Keep the dispatcher read-only. Do not forward repository or environment
      secrets. Do not use `secrets: inherit`. Called jobs still receive GitHub's
      scoped read-only `GITHUB_TOKEN`.
- [ ] Call `$/.github/workflows/ci.yml` only after admission. Keep the call job
      dependent on `admit`.
- [ ] Run the protected candidate-execution and evidence-instrument comparison
      after exact checkout and before the admission summary. Compare the
      admitted base and source objects. Do not invoke candidate code or pnpm
      during admission.
- [ ] Keep the comparison path set above intact. Do not add a content hash
      registry for data already bound by the two Git objects.
- [ ] Keep the semantic retained `ci.yml` graph pin current. Review each pin update against the changed CI graph.
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
- [ ] Reject reintroduction of the legacy selector steps or Bash gate
      regression suite. Do not exclude a retained package, policy, trust,
      documentation, browser, build, generation, or test command.
- [ ] Reject package-execution path drift during admission. Ordinary
      CI remains the validation path for package, dependency, and toolchain PRs.
- [ ] Reject evidence-instrument drift during admission: `ci.yml`, the
      dispatcher, the CI contract source and test entry point, the no-skip
      checker and runtime parser, all focused contract definitions, and both
      protected local action trees stay protected. Do not count
      instrument-changing pull requests.
- [ ] Keep every package-execution admission path family in the ordinary
      `controlPlane` filter. A qualifying ordinary-force-all proof must run
      every retained job to success.
- [ ] Keep the focused setup/package-policy, indexer handler invariant, and
      dependency-cruiser root steps exact, unconditional, and blocking in audit
      mode.
- [ ] Keep the audit step-skip allowlist closed. Every retained command must
      execute and remain blocking. Reject equivalent legacy entry points.
- [ ] Keep the same-repository candidate inside the accepted threat model. The
      audit controls workflow selection and package execution configuration. It
      does not sandbox deliberate process creation inside retained candidate
      product, test, or dependency code.
- [ ] Keep dispatch manual. Obtain approval for any new audit run and its spend
      limit. The completed M6 evaluation grants no further run authorization.

Run `pnpm ci:contract:test` after any change to these facts. Do not dispatch the
audit from an implementation pull request. Run the dispatcher from protected
`main`.

## 2. Branch enforcement on `workflow_dispatch`

`workflow_dispatch` lets any maintainer with write access trigger a workflow from any branch. For deploy workflows, this bypasses the trust-main quality gate.

- [ ] Every deploy job MUST include `if: github.ref == 'refs/heads/main'` (or equivalent environment guard) at the job level
- [ ] Don't rely on the `push.branches: [main]` filter alone — `workflow_dispatch` doesn't honor it

Example: the `deploy` job guard in `metrics-bridge.yml`.

## 3. Pinning third-party actions

A `uses: org/action@v4` line trusts whoever owns that tag to never re-point it at malicious code. Tags are mutable; commit SHAs are not.

- [ ] All third-party actions in workflows and composite actions MUST be pinned to a full commit SHA with the tag in a comment: `uses: org/action@<40-char-sha> # v6.0.2`
- [ ] Self-repository actions such as `uses: $/.github/actions/pnpm-install` and local relative actions such as `uses: ./.github/actions/pnpm-install` are allowed. Use `$` when the action must come from the running protected commit. Use `./` when the checked-out source intentionally owns the action. The scanner follows either target and checks nested third-party `uses:` entries too.
- [ ] Run `node scripts/workflows/check-github-action-pins.mjs` locally when editing `.github/workflows/**`, `.github/actions/**`, or `.trunk/setup-ci/**`; the required `Code Quality` workflow runs the same check on every PR.

Example: every external action in `metrics-bridge.yml` is SHA-pinned.

## 4. Concurrency and serialization

- [ ] Deploy workflows MUST set a concurrency group that serializes ALL invocations against the same target (e.g. `group: ${{ github.workflow }}`, with `cancel-in-progress: false`). Two close main-merges racing on `gcloud run services update` can otherwise stomp each other
- [ ] Non-deploy workflows MAY use a per-ref concurrency group with `cancel-in-progress: true` to drop stale runs on force-push

Example: the workflow-level `concurrency` block in `metrics-bridge.yml`.

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

Dependabot covers two ecosystems in `.github/dependabot.yml`: `github-actions`
and `npm`. Both run weekly on Monday. The npm entry batches routine workspace
updates into themed groups (`next-runtime`, `envio-runtime`, `nest-runtime`,
`playwright-runtime`, `chain-stack`, `test-toolchain`, `lint-toolchain`, plus
`production-misc` and `tooling` catch-alls) and mirrors those boundaries for
security updates. `minimumReleaseAge: 4320` in `pnpm-workspace.yaml` is a
separate three-day install-time guard for versions not listed in
`minimumReleaseAgeExclude`. GitHub-issued security advisories on `pnpm-lock.yaml` open
as soon as the advisory publishes; the schedule does not apply to them. See
[ADR 0092](../adr/0092-dependabot-npm-version-updates.md).

Dependabot groups routine updates. One exact group can auto-merge through
`.github/workflows/dependabot-auto-merge.yml`. Every tier below it requires an
operator-authorized merge.

- **GitHub-owned `actions/*` patch / minor in `actions-minor-patch`:** the only
  auto-merge lane; it merges after required checks pass.
- **Third-party GitHub Actions:** includes load-bearing gates such as
  `re-actors/alls-green` and credential actions such as
  `google-github-actions/auth`.
- **Major:** also requires human review. Check action input/output changes and
  ESM-only migrations that can skip dependents. Use `@codex review` for a
  second opinion.
- **Maintainer changes:** at every tier.
- **Security advisories:** bypass cooldown and stay outside the named routine
  group.
- **`actions/create-github-app-token`:** this action can mint GitHub App
  installation tokens. Keep credential tooling outside the lane so it cannot
  change an authentication boundary by itself.
- **`anthropics/*`:** these actions participate in the review boundary and
  remain separate from other third-party groups.
- **`dependabot/*`:** `dependabot/fetch-metadata` classifies the auto-merge
  lane, so it cannot update itself through the lane. Dependabot-owned actions
  remain separate from other third-party groups.
- **Every npm group, version or security:** the auto-merge classifier requires
  the `github_actions` ecosystem, so no npm PR can enter the lane.

All version-update tiers use `default-days: 7`; the `github-actions` ecosystem
has no per-tier cooldown. GitHub skips cooldown for security updates. Requiring
the exact `actions-minor-patch` dependency group and `actions/*` publisher
boundary keep those immediate security updates outside auto-merge.

The lane has two pinned workflows, and
[ADR 0081](../adr/0081-narrow-dependabot-auto-merge-exception.md) owns their
full proof list and accepted residuals. The read-only `pull_request` classifier
verifies the event and the pinned Dependabot metadata. The default-branch
`workflow_run` writer treats that completion as an untrusted signal: it
re-reads authoritative GitHub state, requires one open same-repository PR with
verified Dependabot-authored commits and only modified top-level workflow YAML,
always rejects changes to either trust workflow, waits for every required
check, repeats the complete proof with the issue-event read last, and finishes
with a synchronous exact-head squash REST merge that cannot enqueue. A recorded
close is a durable human veto that reopening the same PR and head does not
clear; Dependabot must open a new PR to re-enter the lane. The writer refuses
while `main` has a merge queue. A stale head writes nothing: with `main` no
longer requiring an up-to-date PR
([ADR 0104](../adr/0104-non-strict-required-status-checks.md)) the writer
proves `behind_by == 0` itself, emits a `::warning::` and job summary naming
the PR and `behind_by`, and stalls until Dependabot's scheduled rebase or a
human `@dependabot rebase`. Neither workflow checks out or executes PR code,
the writer reads no upstream outputs, artifacts, or caches, and `pnpm tf:test`
pins both parsed workflow shapes.

Before changing the classifier policy or successful job shape, drain every
in-flight run from the prior classifier version or add an explicit runtime
version binding. The writer uses the stable workflow ID and path. Those values
alone do not distinguish old classifier source from new classifier source.

`GH_READ_TOKEN` and `FINAL_MERGE_TOKEN` both resolve to `github.token` by
design. Keep the variables separate so tests can prove that all evidence reads
use the read seam and only the synchronous exact-head REST request uses the
final-write seam. A `GITHUB_TOKEN` merge emits no `push` workflows, so required
PR checks are this lane's final automated evidence. A future merge-queue
rollout must keep the lane disabled until a reviewed design defines its queue
behavior. This lane will not add a `merge-operators` Team, credential broker,
dedicated merge App, protected merge Environment, or controlled lifecycle
ruleset; issue #2091 was closed as not planned.

- [ ] If you add a new external review integration — GitHub App or Action — that is load-bearing for review or merge gating, keep its updates outside routine groups when an isolated review improves the self-update boundary
- [ ] If you add a new `package-ecosystem` to `dependabot.yml`, keep it on the
      operator-authorized path unless a separate reviewed decision defines its exact lane.
      npm has a larger transitive blast radius than GitHub Actions.

## 8. Runner architecture (ARM vs x64)

Every job runs on a free, unlimited GitHub-hosted label — `ubuntu-latest` (x64) or `ubuntu-24.04-arm`. This is a public repo, so there is no per-minute rate to trade off; the only costs left are cache correctness and tool availability.

Decision framework for `runs-on`:

- [ ] **Default to `ubuntu-latest`.** Use `ubuntu-24.04-arm` only for a job that writes no persistent cache and runs no pnpm install. The pnpm-store cache key embeds `runner.arch`, and the sole writer (`production-infra-contract`) is x64 — an ARM install is always a cold miss.
- [ ] **Anything launching Chrome via chrome-launcher/puppeteer/lhci** → x64, hard requirement: Google publishes no Chrome for linux-arm64. (Playwright's own Chromium DOES ship arm64 — only Chrome-dependent tooling is blocked.)
- [ ] Jobs that generate artifacts consumed by another job (`update-snapshots.yml` baselines ↔ ci.yml `ui` snapshot assertions) MUST stay on the same architecture as their consumer.
- [ ] Every `runs-on` label must be in the frozen `ALLOWED_RUNNER_LABELS` set in `scripts/workflows/check-ci-contract.mjs`, which also asserts `.github/actionlint.yaml` and `.trunk/configs/actionlint.yaml` stay byte-identical. Binary caches get arch-keyed (see §5).

## 9. Notifier coverage — keeping Slack alerts wired

`notify-slack-on-main-failure.yml` fires for every workflow whose failure would otherwise be silent. Keep it in sync when adding a workflow.

- [ ] If the new workflow runs on push to `main` (`on.push.branches: [main]`, OR a branchless `on.push:` with no `branches:`/`branches-ignore:` key, which runs on every branch) OR has `on.schedule`, add its `name:` value to the `workflow_run.workflows` list in `notify-slack-on-main-failure.yml`
- [ ] If it's intentionally advisory/non-blocking and you don't want Slack noise on flakes, add its `name:` value to the `EXCLUDED_NAMES` set in `scripts/workflows/check-notifier-coverage.mjs` with a comment explaining why
- [ ] `node scripts/workflows/check-notifier-coverage.mjs` must pass after the change — it runs in the `scripts` CI job. That job's `rootScripts` path filter includes `.github/workflows/**`, so adding a workflow file alone fires the check; no script edit is required

`workflow_run.workflows` does NOT support wildcards — every new workflow name must be listed explicitly.

## 10. Autofix CI trust boundary — machine-authored PRs are untrusted

PRs on the head branch `sentry-autofix/*` are same-repo, non-fork,
non-Dependabot — they pass every historical CI trust check — but their diffs
were machine-authored from untrusted Sentry input, so any secret a
`pull_request` job exposes to their PR-head code is an exfiltration channel
(issue #1388). `scripts/workflows/check-autofix-ci-trust.mjs` enforces this
structurally in the `scripts` CI job.

[ADR 0106](../adr/0106-sentry-triage-moves-to-operator-skills.md) deleted the
autofix leg, so nothing creates that branch any more and the guards below are
inert. They stay because the checker is what enforces them, and because the same
checker carries the repo-wide `pull_request_target` refusal. Treat this section
as live: it still governs where a new secret-bearing lane may go. Retiring the
namespace is a separate task. It parses the workflow with `js-yaml` and analyzes the parsed
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
- PR #191 — supply-chain `paths:` filter would have skipped the required check on PRs that don't touch deps, blocking unrelated merges
- PR #191 — third-party actions weren't all SHA-pinned, a supply-chain trust gap
- PR #188 — indexer codegen cache key missed the codegen scripts; output went stale on script-only changes
- PR #186 — "bridge changes" path filter missed the workflow file itself, so workflow edits didn't re-run
- PR #821/#822 — "ARM is 37.5% cheaper" was falsified for CPU-bound jobs: ~2–3.4× slower + round-up billing made them costlier on ARM, so only network-bound/sub-minute jobs migrated. Trunk's `~/.cache/trunk` binaries are architecture-specific, so its cache key includes `${{ runner.arch }}`

## 12. CI health budget

ADR 0100's report is context, not a gate, except:

- [ ] `CI` `pull_request` wall p90 <= last month's p90 + 1 min.
- [ ] No `CI` step fails in >1% of sampled runs (distinct); else file a deflake issue (step + owner).
