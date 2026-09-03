---
title: CodeRabbit replaces Cursor BugBot as the third PR review bot
status: active
owner: eng
canonical: true
last_verified: 2026-09-03
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0066 — CodeRabbit replaces Cursor BugBot as the third PR review bot

**Status:** Accepted (Aug 2026) — BugBot disabled on 2026-08-31; the live
compatibility paths retired on 2026-09-02; amended 2026-09-02 (usage add-on
enabled, incremental reviews off).
**Scope:** ci/process

## Context

Before this decision, every PR got three AI reviewers: Cursor BugBot
(`cursor[bot]`), OpenAI Codex (`chatgpt-codex-connector[bot]`), and Claude Code
(`claude[bot]`), plus a local pre-push Codex autoreview. BugBot's check was not
required, and its lag did not block under ADR 0007. Its actionable comments
still blocked the feedback ledger. The Dependabot auto-merge flow that existed
when this ADR was accepted cited BugBot's risk summary as advisory. The current
narrow workflow pair does not use a review bot as an eligibility input. The
current review stack replaces BugBot with CodeRabbit. Codex and Claude continue
to run on subscriptions that the team pays for other reasons.

BugBot was disabled in the Cursor dashboard on 2026-08-31. Its compatibility
paths retired on 2026-09-02, once the last legacy PR closed. Two carried real
weight: `cursor[bot]` in the feedback-state bot roster, and `Cursor Bugbot` in
the optional-check allowlist. The third, `BUGBOT_BUG_ID` in the two
actionable-marker regexes, was already unreachable and enforced nothing —
`reviewContradictionBody` strips `_` before the top-level regex sees a body, and
the Claude clean-review caller short-circuits before its own severity rule. Its
removal is therefore inert. None of the three ever triggered a new BugBot
review.

That bill changed shape. Cursor announced on 2026-05-11 (effective at each
customer's first renewal after 2026-06-08) that BugBot dropped its flat
$40/seat/month price and moved to usage billing at roughly $1.00–1.50 per
review run, with three properties that matter here:

- The default trigger re-reviews the **full PR on every push**; incremental
  review is opt-in.
- There is **no BugBot-specific spending cap** — only the Cursor account's
  general monthly spend limit bounds it — and no per-run cost line on the bill.
- There is **no free or discounted tier** for public repositories.

This repo is the worst case for that model. One login (`chapati23`) authors
~280 merged PRs/month (~850 in 90 days), and the agent workflow pushes several
fix-commit rounds per PR, so review runs land at roughly 2–4× the PR count
(560–1,120 runs/month). At $1.00–1.50/run that is **~$560–1,680/month**, versus
$40/month (one PR-author seat) under the old flat model. This is the mechanism behind the
observed cost growth; Cursor's own forum documents the same effect on other
iteration-heavy teams.

Decision criteria: review quality and cost.

### Quality evidence

- **This repo's own history** (last 40 merged PRs, #1843–#1911, sampled
  2026-08-18): 26 inline bot findings, all 26 answered "Fixed in `<commit>`",
  zero won't-fix. BugBot contributed 5 findings on 4 PRs, Codex 15 on 3 PRs,
  Claude 6 on 3 PRs. All three bots delivered accepted findings in this sample;
  the sample is too small and bursty to measure noise rates.
- **The strongest independent head-to-head** (146 PRs / 679 findings, four
  bots run in parallel for 3 weeks, published May 2026): false-positive
  rates — the study counts FP/(fixed+FP), excluding pending findings — were
  Greptile 0% (118 audited findings), CodeRabbit 2.3% (281), BugBot 4.8%
  (128), and Sentry Seer — the fourth bot — ~9%. 93.4% of findings were
  caught by exactly **one** tool and none by all four — the bots are
  complementary, so removing one costs real coverage.
- **Martian Code Review Bench**, the only independent rolling benchmark found:
  CodeRabbit topped the March 2026 snapshot (F1 51.2%), Greptile the July 2026
  snapshot (F1 60.8%, precision 76.2%). The leaders cluster at 50–61% F1 and
  the ranking flips between snapshots. Vendor-run benchmarks are unreliable:
  an independent re-run of Greptile's own 50-bug set measured 45% recall
  against the self-reported 82%.

Read together: no candidate had a decisive quality edge. During the comparison,
BugBot was the quiet, precision-first reviewer — a role Codex (deliberately
P0/P1-only) already filled. CodeRabbit and Greptile were the two credible
replacements, and both measured lower false-positive rates than BugBot in the
independent study.

### Two-week comparison outcome

The repository completed the planned parallel comparison before the operator
disabled BugBot. CodeRabbit touched 141 of 145 PRs. It posted 326 inline
findings on 93 PRs. The audit classified 319 findings: maintainers marked 284
fixed and 35 as won't-fix. CodeRabbit conceded 28 of the won't-fix findings as
false positives. It posted six Critical findings: five were fixed and one was
conceded.

Twenty PRs received findings from both reviewers. CodeRabbit posted 105
findings on those PRs, and BugBot posted 29. Only nine findings matched the
same file and line. The low overlap supports the original conclusion that the
reviewers were complementary, but CodeRabbit supplied more review coverage
during the comparison. The operator chose to keep the Pro+ plan and disabled
BugBot after reviewing these results.

### Cost at this repo's shape (1 PR-author seat, ~280 PRs/month, public repo)

| Option              | Pricing model                                 | Est. monthly cost                                        |
| ------------------- | --------------------------------------------- | -------------------------------------------------------- |
| BugBot (status quo) | ~$1.00–1.50/run, uncapped, re-review per push | ~$560–1,680                                              |
| CodeRabbit          | Pro+ seat $48–60/mo; usage add-on deferred    | **$48–60** (chosen); ~$60–180 with add-on; OSS $0        |
| Greptile            | $30/seat incl. 50 reviews, then $1/review     | ~$260 (review-on-open only); $540–1,100 (re-review/push) |
| Cubic               | Free unlimited on public repos                | $0                                                       |
| Graphite Agent      | Flat $20–40/month, unlimited reviews          | $20–40                                                   |
| Drop to two bots    | —                                             | $0, minus third-bot coverage                             |

The CodeRabbit row records the 2026-08-18 estimate. The add-on was later
enabled and its real cost overran that row — see the 2026-09-02 amendment
below.

CodeRabbit's public-repo terms were verified against the vendor's docs and
the installed org's billing page on 2026-08-18. The Open Source tier gives
public repos **Pro+ features free**, with no application step and no license
requirement; company-owned public repos included. Two limits shape it: OSS
rate limits are per-repository and popularity-scaled (1–10 reviews/hour),
and public repos with **fewer than 10 stars get no automatic reviews** —
every review is triggered manually (`@coderabbitai review`). This repo has 0
stars, so the $0 tier is manual-trigger-only; the trigger is a PR comment an
agent or babysit loop can post. Seats bill per Git identity that **opens** a
PR — pushing commits consumes nothing — so the paid path is one seat.

Rate limits decided the tier. The OSS tier has no usage-based buy-out: when
its star-scaled ~1 review/hour allowance is exhausted, the review waits.
Paid plans meter per developer identity under a fair-usage ladder — Pro
sustains 1 review/hour once an identity passes 60 reviews per 7 days, while
Pro+ still sustains 4/hour at this repo's ~65 reviews/week (falling to
1/hour only past 90) — and both can enable the **usage-based add-on**
(25¢ per reviewed file) so over-limit reviews continue instead of waiting.
Observed at install: the org lands on a default 14-day Pro+ trial (3
reviews/developer/hour, the source of the first rate-limit refusal). The
operator upgraded the org to a paid Pro+ seat on 2026-08-18.

## Decision

Replace BugBot with CodeRabbit as the third advisory reviewer.

1. **Install and subscribe** (done 2026-08-18): the CodeRabbit GitHub App
   with one paid **Pro+** seat ($60/month on monthly billing; $48/month
   annual), chosen for throughput — 10 reviews/hour nominal, 4/hour
   sustained at this repo's volume, automatic reviews on every PR. The
   **usage-based add-on** (25¢ per reviewed file on over-limit reviews) is
   deferred: the operator decided on 2026-08-18 to feel the rate-limit
   friction first, at flat seat cost, and enable the add-on only if that
   friction proves annoying. Until then, over-limit reviews wait instead of
   billing. **Superseded 2026-09-02** — the add-on was enabled in Automatic
   mode with a $500/month cap; see the amendment below. The $0 OSS tier (Pro+
   features, ~1/hour, manual-trigger-only under 10 stars, no add-on) remains
   the documented fallback if spend must return to zero.
2. **Commit `.coderabbit.yaml`** (done 2026-08-19 in PR #1927): use the `chill`
   profile, `path_filters` that exclude lockfiles and generated trees, and
   `auto_pause_after_reviewed_commits: 5`. The initial value of 2 paused normal
   one-fix PRs because the opening review counts as the first reviewed commit.
   The vendor default of 5 preserves the burst guard without treating one
   normal fix round as active development. The ship and babysit closeout
   requests one manual review for an exact head when the automatic review is
   stale or missing after the optional check becomes terminal.
   **Amended 2026-09-02** — `auto_incremental_review: false` means no
   automatic review follows a push, so the closeout request no longer waits
   for one; the pause threshold now only matters if incremental reviews
   return.
3. **Run both reviewers for two weeks** (complete 2026-08-31). Compare their
   findings on the same PRs. Use the result to confirm or reverse the decision.
4. **Disable BugBot** (complete 2026-08-31) and **retire the compatibility
   paths** (complete 2026-09-02). Disabling stopped new reviews while legacy
   feedback enforcement stayed live for open PRs. PR #2036, the last PR
   carrying a legacy Cursor finding, merged on 2026-09-01. The live sweep on
   2026-09-02 covered all four open PRs and found no cursor[bot] comment or
   review on any of them, so the live paths came out of
   `scripts/pr/pr-feedback-state-core.mjs`,
   `scripts/pr/pr-feedback-state-claude.mjs`, and
   `scripts/pr/pr-ready-state-core.mjs`. Issue #2178 owns the related
   readiness projection update.
5. **Use CodeRabbit's native monthly report** (configured 2026-09-02). The
   `Monthly CodeRabbit value review` report runs on day 1 at 09:00
   Europe/Berlin, filters to `monitoring-monorepo`, and delivers by email. It
   uses CodeRabbit's organization statistics and bot comments to report review
   coverage, suggestions, accepted suggestions, noise, a value verdict, and up
   to three evidence-linked improvements. It replaces the local metrics
   collector, and the repository carries no replacement schedule. Historical
   cohort artifacts stay under `docs/metrics/`. If a future decision needs
   cross-bot forensic evidence, create a narrow issue-scoped query for that
   decision.

## Amendment 2026-09-02 — usage add-on enabled, incremental reviews off

This corrects the "add-on deferred" record above. Decision step 1, the cost
table, and the first Consequences bullet describe the state as of 2026-08-18
and stay in place as history.

- **The add-on was enabled, not deferred.** It runs in Automatic mode with a
  $500/month cap. The enabling date was not recorded; the billing page showed
  it active on 2026-09-02.
- **The vendor renamed the plan tiers.** Checked 2026-09-02,
  docs.coderabbit.ai/management/plans calls the tier this org holds **Team**
  (formerly Pro+): $48/developer/month annual, $60 month-to-month, 8 PR
  reviews/hour, 300 files per review. Pro is now Essentials. The rate-limit
  notice on PR #2236 reported `Plan: Team` for that reason — the same seat
  under a new name, not a downgrade. Sections above this amendment keep the
  Pro+ name they were written with.
- **The cap was reached on 2026-09-02**, sixteen days before the cycle resets
  on 2026-09-18. Past the cap only the free refill runs — 1 review/hour for
  the sole PR author, who sits permanently in the 90+ reviews/7-days tier —
  and every other push is blocked.
- **30-day Review usage, team view, read 2026-09-02:** 672 review events, 365
  continued with credits (billed), 48 blocked, 3.9 review events per PR, ~5.5
  billed files per continued review. CodeRabbit meters pushes, not commits or
  files: each push past the hourly refill bills every file in that push's
  delta at 25¢, so agent fix rounds re-bill the same files several times per
  PR.
- **Decision:** set `reviews.auto_review.auto_incremental_review: false` in
  `.coderabbit.yaml`. CodeRabbit then reviews a PR once when it opens and once
  more at closeout, when the ready-state flow posts the head-bound
  `@coderabbitai review` request that
  [`../notes/pr-ready-state.md`](../notes/pr-ready-state.md) already defines.
  Intermediate pushes get no automatic CodeRabbit review. Codex still reviews
  every push automatically, but Claude does not: `.github/workflows/claude.yml`
  triggers on `opened` and `ready_for_review` only, so a Claude re-review is
  opt-in via `@claude review`. The coverage an intermediate push keeps is
  therefore Codex alone. No required gate changes, because CodeRabbit's own
  check was already advisory — but read the accepted residual below for what this
  does cost. Expected: review events per PR fall from ~3.9 to ~2, each changed
  file bills at most twice per PR, and spend lands at an estimated
  $200–$250/month at current volume.
- **The repository file governs this key.** The organization-level Global
  overrides applied on 2026-09-02 pin `reviews.profile`,
  `request_changes_workflow`, `auto_review.enabled`, `auto_review.drafts`, and
  `auto_review.auto_pause_after_reviewed_commits`. They do not set
  `auto_incremental_review`, so `.coderabbit.yaml` decides it and
  `scripts/coderabbit-config.test.mjs` is its only guard. **Follow-up, now
  indicated rather than conditional:** the operator adds
  `auto_incremental_review: false` to the Global overrides. PR #2236 measured
  the repository file on its own and it did not hold — see the next bullet.
- **Measured on PR #2236: the repository file alone did not suppress the
  attempt.** This bullet is the single tally; the runbooks point here rather
  than carrying their own counts, which went stale every time the PR pushed.
  As of 2026-09-03, five pushes each drew a CodeRabbit run within roughly 75
  seconds, with `auto_incremental_review: false` in force on the branch the
  runs read (`Path: .coderabbit.yaml`, `Review profile: CHILL`):

  | Push          | Head        | Run ID      | Observed             |
  | ------------- | ----------- | ----------- | -------------------- |
  | 1, opening    | `733fa0b83` | `3fdfc30d…` | 2026-09-02 14:40:44Z |
  | 2             | `242f47afb` | `5e05ac36…` | 2026-09-02 15:51:39Z |
  | 3             | `cb273d4e2` | `9739f061…` | 2026-09-02 15:57:49Z |
  | 4             | `32b60c787` | `beabff8f…` | 2026-09-02 16:51:26Z |
  | 5, base merge | `95c3b6dc7` | `c21f85af…` | 2026-09-03 06:43:23Z |

  Runs 1-4 were refused by the spending cap, so nothing was billed. Runs 1-4
  each reported the full base-to-head diff; run 5 reported an incremental
  `4aef1be09`..`95c3b6dc7` delta, the first to do so. One confound stays open:
  the opening review never completed either, and CodeRabbit may retry an
  unfinished review when the head moves regardless of this key. A clean
  measurement needs a PR whose opening review completed, so it waits for the
  2026-09-18 cap reset.

- **The closeout request is the vendor-documented path here, checked
  2026-09-02.** docs.coderabbit.ai/configuration/auto-review states that
  `auto_incremental_review: false` reviews "only when a PR is first opened.
  Subsequent pushes will be ignored until you trigger the review manually", and
  names `@coderabbitai review` as that manual trigger.
  docs.coderabbit.ai/reference/review-commands lists "when automatic reviews
  are disabled" as a use case for the same command, describes it as triggering
  "an incremental review of new changes only", and notes it spends one review
  from the allowance. The "applicable only when automatic reviews are paused"
  line in PR #2236's refusal came attached to a rate-limited command, so it is
  not evidence against the documented path.
- **Confirmed 2026-09-02: the closeout request works.** The head-bound request
  posted against `4aef1be09` at `21:24:54Z` produced a completed CodeRabbit
  review at `21:31:58Z` carrying four inline findings — the first review this
  PR obtained. That settles the open question above: the command is applicable
  under `auto_incremental_review: false`, and the "applicable only when
  automatic reviews are paused" line really was boilerplate on a rate-limited
  refusal. One question remains for the 2026-09-18 re-measure: why pushes
  still trigger runs at all when the documentation says they are ignored. The
  incremental range on run 5 is the sharpest clue — it is the shape an
  incremental review takes, not the shape of a retry of an unfinished opening
  review.
- **Rejected here:** raising the cap keeps the per-push meter and buys more
  duplicate reviews; tightening `path_filters` saves little because the billed
  unit is an already-small push delta. The $0 OSS tier stays the fallback if
  spend must return to zero.
- **Accepted residual:** the closeout request is now the final scheduled
  request in the ready-state flow, and readiness never waits for it.
  `summarizeCodeRabbitReviewGate` returns `required: false`, `ready` is
  `required.ready` in `scripts/pr/pr-ready-state-core.mjs`, and
  `pr-ready-state.test.mjs` pins "never awaits a pending CodeRabbit check for
  readiness" — so a head can reach all-clear with its CodeRabbit signal still
  `requested`. That was already true before this change; incremental review
  only made it unlikely to bite, because the final head usually already
  carried an automatic review. The partial cover stays as
  [`../notes/pr-ready-state.md`](../notes/pr-ready-state.md) states it: if the
  requested review lands while the PR is still under watch, rerun
  `pr:feedback-state` and handle its findings before all-clear. Making the
  CodeRabbit signal blocking is a separate decision this ADR does not take.
- **Revisit trigger:** closeout-only coverage missing defects that incremental
  reviews would have caught, heads merging with the closeout review still only
  `requested`, or spend still tracking toward the cap after the 2026-09-18
  reset.

## Alternatives considered

- **Greptile** — strongest precision on the current Martian snapshot, 0% false
  positives in the 146-PR study, and full-codebase context. Rejected on cost
  and terms: its OSS program requires a non-commercial project, so this
  company-owned public repo pays; the March 2026 base-plus-metered model
  ($30/seat + $1/review past 50) recreates BugBot's failure mode at this
  volume (~$260–1,100/month). 2026 billing-conduct reports (approved OSS
  maintainers billed anyway, refunds only after public pressure, cancellation
  only via support) add vendor risk.
- **Keep BugBot with mitigations** (opt-in incremental review, manual-only
  triggers). Cuts spend materially, but the bill stays metered, uncapped, and
  per-run-invisible, and quality does not justify the premium: BugBot
  duplicates the precision-quiet role Codex already fills.
- **Drop to two bots** — $0, but measurable coverage loss: 93.4% of findings
  in the parallel study were caught by exactly one tool, and BugBot delivered
  5 accepted findings in the last 40 merged PRs here. CodeRabbit's OSS tier
  dominates this option at the same $0 (coverage retained, reduced cadence);
  the chosen Pro+ seat buys the automatic cadence on top.
- **Cubic / Korbit / Ellipsis** (free-for-public-repo tiers) — genuine $0
  candidates, but with thin or no independent quality evidence. Cubic
  (vendor-claimed 11% false-positive rate) is the designated zero-cost
  fallback if CodeRabbit's public-repo terms change.
- **Graphite Agent** ($20–40/month flat, unlimited) and **Qodo Merge /
  self-hosted PR-Agent** — predictable cost, but weaker independent evidence
  than CodeRabbit, and not $0.
- **GitHub Copilot code review** — highest reported false-positive rate of the
  field (~15–25%), and since June 2026 it consumes Actions minutes on top of
  seat credits.
- **Vercel Agent review** — sandbox-validated fixes are a real differentiator,
  but $0.30/review plus tokens is the same per-run meter BugBot has
  (~$170–330+/month here).

## Consequences

- Review spend drops from ~$560–1,680/month (est.) to a flat $48–60/month for
  one Pro+ seat while the usage-based add-on stays deferred (over-limit
  reviews wait rather than bill); enabling the add-on later would add up to
  25¢ per reviewed file on over-limit reviews, realistically under
  ~$180/month in heavy months, with path filters shrinking the file counts.
  BugBot's per-run meter, which scaled with agent iteration, is gone from the
  default path either way, and the $0 OSS fallback caps downside.
  **Superseded 2026-09-02**: the add-on was on, and add-on spend reached its
  $500/month cap rather than staying under ~$180. See the amendment below.
- The stack's third seat changes character from precision-quiet to
  high-recall. CodeRabbit's known weakness is verbosity; the quiet/chill
  profiles, path filters, and pause-after-reviewed-commits are the levers, and
  the feedback-ledger discipline (every finding gets a Fixed/Won't-fix reply)
  already forces per-finding triage. Post-rollout evidence raised the pause
  threshold from 2 to 5. If noise stays high after tuning, that is a revisit
  trigger, not a live-with-it.
- No CodeRabbit tier auto-reviews every push unmetered at this repo's
  volume. Pro+ sustains 4 reviews/hour at ~65 reviews/week and drops to
  1/hour past 90, so agent fix-commit bursts either wait or bill through
  the add-on. Keep `auto_pause_after_reviewed_commits` at 5 and request one
  head-bound `@coderabbitai review` at closeout when the automatic review is
  stale or missing. This spends the ladder on review rounds that matter while
  preventing duplicate requests for the same head. **Amended 2026-09-02**:
  agent fix bursts now do neither — incremental auto-review is off, so they
  get no CodeRabbit review at all and the closeout request is the second and
  last one per PR.
  `@coderabbitai rate limit` reports remaining capacity without consuming
  a review.
- The 2026-08-31 open-PR sweep found one current-head Cursor finding, on PR
  #2036; that PR merged on 2026-09-01. The follow-up sweep on 2026-09-02 read
  all four open PRs and found no Cursor comment or review, so `cursor[bot]`,
  `BUGBOT_BUG_ID`, and the optional `Cursor Bugbot` check classification came
  out the same day. Scope the effect narrowly: only the top-level comment and
  review-body ledger consults the bot roster, so only a stray **top-level**
  Cursor comment is ignored — an unresolved Cursor review thread or unreplied
  root inline comment still blocks like any other author's, and every Cursor
  finding this repo recorded was inline. A stray `Cursor Bugbot` check reads as
  an unrecognized context: optional when branch protection reports required
  contexts that do not name it, required in the fallback path that runs when
  those contexts are unavailable — a path that already reports its own
  `branch-protection` blocker. Historical Cursor evidence stays in this ADR,
  prior measurement artifacts, and frozen review fixtures.
- CodeRabbit is a new third-party GitHub App with repo read access and PR
  comment/review write access, steered by `.coderabbit.yaml` — and CodeRabbit
  resolves that file from the **source branch** of the PR under review,
  falling back to defaults when absent, so a PR can weaken or replace the
  profile that reviews it. That was acceptable only while the bot's output
  fed nothing required. PR #1927, the 2026-08-19 CodeRabbit ADD phase,
  satisfied the pre-gate condition this bullet used to defer:
  `scripts/coderabbit-config.test.mjs` pins the
  committed config by exact equality and runs in required CI
  (`pnpm coderabbit:config:test`), so a source-branch edit to
  `.coderabbit.yaml` fails the build instead of silently weakening the
  reviewer; and the feedback-ledger roster
  (`scripts/pr/pr-feedback-state-core.mjs` and
  `scripts/pr/pr-feedback-state-claude.mjs`) carries marker-recognition tests
  for CodeRabbit's finding markers (`cr-indicator-types`, the severity badge)
  and its non-finding machinery (rate-limit, summary, trigger-ack,
  thread-resolved-ack). CodeRabbit's inline findings now feed
  `pr:feedback-state`, the merge oracle; its own check context stays
  advisory (`scripts/pr/pr-ready-state-core.mjs`). Two residuals, accepted:
  the pin is fail-loud, not fail-secure — CodeRabbit reviews the source
  branch before CI runs, so a weakened config still shapes that one PR's
  review, and a same-patch edit to config plus pin is visible rather than
  impossible (any in-repo policy is PR-editable; comparing against a
  trusted ref would freeze legitimate config changes and recurse the same
  loophole). The out-of-repo close is set: on 2026-09-02 the operator
  applied CodeRabbit's organization-level **Global overrides**, which the
  vendor ranks above a repository's `.coderabbit.yaml`, so a PR can no
  longer weaken these keys from its source branch. The override pins
  `reviews.profile: chill`, `reviews.request_changes_workflow: false`,
  `reviews.auto_review.enabled: true`, `reviews.auto_review.drafts: false`,
  and `reviews.auto_review.auto_pause_after_reviewed_commits: 5`. It omits
  `path_filters` and `path_instructions` on purpose: both are tuned in-repo
  against evidence, and the vendor docs do not state whether an override
  replaces or merges list values. Those two keys keep the fail-loud in-repo
  pin above and its residual — a weakened path filter still shapes the
  review of the PR that weakens it, because CodeRabbit reads the source
  branch before CI runs.
- Watch item: `claude[bot]` review currently rides existing Max
  subscription spend. Anthropic's separate metered "Code Review" product bills
  $15–25/review — ruinous at this volume. If the GitHub Action review path is
  ever folded into that product, this ADR's math changes and the stack needs
  re-deciding.
- Fallback ladder from the paid seat: down to CodeRabbit's $0 OSS tier
  (reduced, manual-trigger cadence); sideways to Cubic (free unlimited on
  public repos) or Graphite Agent (flat $20–40/month unlimited) if
  unmetered volume ever outranks CodeRabbit's quality evidence.

## Evidence

- BugBot usage pricing and mechanics: cursor.com/blog/may-2026-bugbot-changes
  (announced 2026-05-11, effective first renewal after 2026-06-08),
  cursor.com/blog/bugbot-updates-june-2026 (22% cheaper, incremental review
  opt-in), cursor.com/docs/bugbot (default full-PR re-review per push; no
  spend cap). Iteration-cost reports: forum.cursor.com thread
  "usage-based Bugbot pricing punishes iterative workflows" (May 2026).
- CodeRabbit configuration precedence: docs.coderabbit.ai/guides/configuration-overview
  (checked 2026-09-02) ranks organization-level global overrides above a
  repository's `.coderabbit.yaml`. The applied override was read back in the
  CodeRabbit UI on 2026-09-02 under Organization settings → View mode →
  Global overrides.
- CodeRabbit Reports UI, read back on 2026-09-02: the active
  `Monthly CodeRabbit value review` report filters to `monitoring-monorepo`,
  runs monthly on day 1 at 09:00 Europe/Berlin, includes organization statistics
  and bot comments, and has email delivery configured.
- CodeRabbit pricing and public-repo terms: coderabbit.ai/pricing,
  docs.coderabbit.ai/management/plans, docs.coderabbit.ai/management/seat-assignment
  (seat = PR-opener; pushes free), kb.coderabbit.ai article 8856795235
  (open-source activation). The plans page carries the fair-usage ladders
  (Pro 5→1/hour, Pro+ 10→1/hour by 7-day volume), the OSS star-scaled
  1–10/hour per-repo limits, the under-10-stars manual-trigger rule, and
  add-on availability (paid plans only). The installed org's billing page
  confirmed the default Pro+ trial and the 2026-08-18 paid upgrade. All
  checked 2026-08-18.
- Usage add-on state and spend: the installed org's CodeRabbit Subscription
  and Usage pages, read 2026-09-02 — add-on Automatic with a $500/month cap,
  cap reached that day, cycle reset 2026-09-18, and the 30-day Review usage
  figures (672 / 365 / 48 / 3.9 / ~5.5) in the amendment above.
- Post-rollout pause sample, queried from GitHub on 2026-08-21: 16 of the 29
  PRs created after `.coderabbit.yaml` merged carried CodeRabbit's generated
  pause marker. Six of those PRs had only 2-4 total commits. Two of the 29 PRs
  carried the rate-limit marker, and neither also carried the pause marker.
- Two-week cutover sample, queried from GitHub on 2026-08-31: 145 PRs after
  installation; CodeRabbit touched 141 and posted 326 inline findings on 93.
  The audit classified 319 findings: 284 fixed and 35 won't-fix, including 28
  vendor-conceded false positives. On 20 shared finding PRs, CodeRabbit
  posted 105 findings and BugBot posted 29; nine matched the same file and
  line. The same sweep found one open current-head Cursor finding on PR #2036.
- Greptile pricing and OSS terms: greptile.com/pricing,
  greptile.com/blog/greptile-v4 (2026-03-05 model change),
  greptile.com/docs/code-review-bot/trigger-code-review (re-review is opt-in
  via `triggerOnUpdates`), ossperks.com/programs/greptile (non-commercial
  requirement). Billing-conduct reports: greptile-fail.vercel.app and the
  linked HN thread.
- Quality: dev.to/\_vjk "We Ran 4 in Parallel for 3 Weeks (146 PRs, 679
  Findings)" (May 2026, independent, open-source harness);
  github.com/withmartian/code-review-benchmark and codereview.withmartian.com
  (independent rolling benchmark; both CodeRabbit and Greptile cite favorable
  snapshots); deepsource.com "Every AI code review vendor benchmarks itself,
  and wins" (2026-02-26, documents the 82%→45% Greptile re-run gap).
- Field-scan pricing (Cubic, Graphite, Qodo, Copilot, Vercel Agent, Anthropic
  Code Review): each vendor's public pricing/docs pages, fetched 2026-08-18 —
  cubic.dev/pricing-plans, graphite.com/blog (2026-01-08 restructure),
  qodo.ai, github.blog changelog (2026-04-27 Actions-minutes change),
  vercel.com/docs/agent/pr-review.
- This repo's numbers: 40-PR sample #1843–#1911 collected 2026-08-18 via
  `gh api pulls/<n>/comments` (26/26 findings fixed; per-bot split above);
  merged-PR volume from `git log --first-parent` (280 in 30 days, 850 in 90);
  BugBot's not-required check status per ADR 0007 and
  `docs/pr-checklists/ci-workflow-gates.md`; and its `BUGBOT_BUG_ID` marker as
  it stood before the 2026-09-02 retirement, per
  `scripts/pr/pr-feedback-state-core.mjs` at that revision. Retained
  `docs/metrics/` artifacts preserve prior measurements.
