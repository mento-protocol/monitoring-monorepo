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

- [ ] **Ruleset-required** workflows MUST NOT use `paths:` / `paths-ignore:` filters — they must run on every PR. If you want path-conditional work, run every PR but skip the expensive job inside via `if:` checks (or `paths-filter`-style gating that reports a green check on no-op).
- [ ] **Advisory** workflows (everything _not_ in the ruleset list above) SHOULD use a workflow-level `paths:` filter so they don't boot a runner on irrelevant PRs. A skipped advisory check is simply absent — it cannot leave a _required_ check pending. This is a deliberate CI-cost control; see `lighthouse.yml`, `size-limit.yml`, `schema-diff.yml`, and `supply-chain.yml` for the pattern (the workflow-level `paths:` mirrors the in-job `filter` step, which is kept as a fail-closed backstop).
- [ ] If you make an advisory workflow required, add it to the ruleset **and** remove its `paths:` filter in the same change.

> ⚠️ The ruleset and these docs have drifted before: several advisory gates were written as if required (run-on-every-PR, no `paths:`) when the ruleset never enforced them. When you add or "promote" a check, update both the ruleset and this list.

## 2. Branch enforcement on `workflow_dispatch`

`workflow_dispatch` lets any maintainer with write access trigger a workflow from any branch. For deploy workflows, this bypasses the trust-main quality gate.

- [ ] Every deploy job MUST include `if: github.ref == 'refs/heads/main'` (or equivalent environment guard) at the job level
- [ ] Don't rely on the `push.branches: [main]` filter alone — `workflow_dispatch` doesn't honor it

Canonical good example: `.github/workflows/metrics-bridge.yml:41`.

## 3. Pinning third-party actions

A `uses: org/action@v4` line trusts whoever owns that tag to never re-point it at malicious code. Tags are mutable; commit SHAs are not.

- [ ] All third-party actions in **deploy / write workflows** MUST be pinned to a full commit SHA with the tag in a comment: `uses: org/action@<40-char-sha> # v6.0.2`
- [ ] First-party actions (`actions/checkout`, etc.) in deploy paths SHOULD also be SHA-pinned for consistency
- [ ] Read-only audit/lint workflows MAY use tag pins, but prefer SHA pins for consistency

Canonical good example: `.github/workflows/metrics-bridge.yml:59,62,68,117` — every external action SHA-pinned.

## 4. Concurrency and serialization

- [ ] Deploy workflows MUST set a concurrency group that serializes ALL invocations against the same target (e.g. `group: ${{ github.workflow }}`, with `cancel-in-progress: false`). Two close main-merges racing on `gcloud run services update` can otherwise stomp each other
- [ ] Non-deploy workflows MAY use a per-ref concurrency group with `cancel-in-progress: true` to drop stale runs on force-push

Canonical good example: `.github/workflows/metrics-bridge.yml:29-31`.

## 5. Caching keys

A cache key that misses an input silently serves stale build artifacts.

- [ ] If the workflow runs codegen (e.g. `pnpm indexer:codegen`), the cache key MUST include the codegen scripts AND every config file that codegen reads (e.g. `config.multichain.mainnet.yaml`, `config.multichain.testnet.yaml`, `schema.graphql`, `scripts/run-envio-with-env.mjs`)
- [ ] Lockfile (`pnpm-lock.yaml`) is necessary but NOT sufficient — codegen output depends on more than dep versions
- [ ] For caches of **external binaries whose version is resolved transitively** (Playwright Chromium under `~/.cache/ms-playwright`, Cypress browsers under `~/.cache/Cypress`, etc.), the cache key MUST include `pnpm-lock.yaml`, NOT just `package.json`. A caret-range dep (`@playwright/test: ^1.60.0`) lets a lockfile-only update flip the resolved Playwright version — and thus the Chromium revision it wants — without changing `package.json`'s hash. Result: every CI run restores the stale cache, the install step re-downloads (~130 MB for Chromium), but `actions/cache` won't re-save under the already-hit key, so the download repeats indefinitely until something forces a `package.json` change. Caught on PR #633 (`.github/workflows/lighthouse.yml` Playwright Chromium cache step). Pair with a `restore-keys:` fallback so unrelated lockfile churn still benefits from a near-match cache.

## 6. Fail-closed audit / security workflows

Audit workflows that "tolerate transient errors" become attack surface — an attacker who can wedge the registry can ship malicious deps during the outage window.

- [ ] Audit workflows MUST fail-closed on registry errors. Don't pass `--ignore-registry-errors` or equivalent
- [ ] If you genuinely need a soft-failure path, gate it behind a manual `workflow_dispatch` with explicit input, not on every PR

## 7. Dependabot policy

Dependabot is scoped to the `github-actions` ecosystem (`.github/dependabot.yml`). npm is handled by pnpm with `minimumReleaseAge: 4320` in `pnpm-workspace.yaml`; GitHub-issued security advisories on `pnpm-lock.yaml` still come through as Dependabot PRs without an `npm` entry.

PRs are grouped + cooldown-throttled and pass through a tiered auto-merge gate (`.github/workflows/dependabot-auto-merge.yml`):

- **Patch / minor** → auto-merge once required CI checks pass (CI / Vercel / Code Quality / Vercel Preview Comments). Cursor Bugbot's risk summary is advisory.
- **Major** → human review required. The two recurring failure modes are (a) action input/output signature breaks not caught by CI, (b) ESM-only migrations that quietly skip dependents. `@codex review` is the on-demand second opinion.
- **Maintainer changes** (the action's upstream maintainer set changed) → held for manual review regardless of tier. Supply-chain signal.
- **Security advisories** (any tier including major) → bypass Dependabot cooldown so CVE patches flow fast; major-tier security PRs still require human merge.
- **Any `anthropics/*` or `dependabot/*` action** → never auto-merged (glob covers future renames + sibling actions). Self-loop: claude-code-action is the auto-reviewer, dependabot/fetch-metadata is what classifies update-type for the auto-merge workflow — a regression in either ships unreviewed and breaks the gate that would catch follow-ups.

Cooldown default in `dependabot.yml`: `default-days: 7`. Per-semver-tier cooldown (`semver-major-days` etc.) is NOT supported for the github-actions ecosystem — only `default-days` is honored, so all tiers share the same delay. Cooldown does NOT apply to security updates (GitHub-enforced). Because auto-merge handles the click, the 7-day delay on routine bumps costs zero friction.

- [ ] If you add a new external Action that's load-bearing for review/merge gating (Cursor Bugbot, Codex, Claude), add it to the auto-merge exclusion list with the same self-loop rationale
- [ ] If you add a new `package-ecosystem` to `dependabot.yml`, decide whether it inherits the same auto-merge policy or needs a separate rule — npm in particular has a larger transitive blast radius than github-actions

## 8. Lessons already paid for

- PR #188 — consolidating per-package CI workflows nearly removed the push-to-main guard on the metrics-bridge deploy and the workflow_dispatch branch check
- PR #191 — `paths:` filter on the supply-chain workflow would have made the required check skip on PRs that don't touch deps, blocking unrelated merges
- PR #191 — third-party actions weren't all SHA-pinned, leaving a supply-chain trust gap
- PR #188 — caching key for indexer codegen missed the codegen scripts; cached output went stale on script-only changes
- PR #186 — workflow path filter for "bridge changes" missed the workflow file itself, so workflow edits didn't re-run
