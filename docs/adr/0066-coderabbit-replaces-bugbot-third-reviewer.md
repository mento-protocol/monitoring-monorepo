---
title: CodeRabbit replaces Cursor BugBot as the third PR review bot
status: active
owner: eng
canonical: true
last_verified: 2026-08-18
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0066 — CodeRabbit replaces Cursor BugBot as the third PR review bot

**Status:** Accepted (Aug 2026) — cutover per the plan under Decision.
**Scope:** ci/process

## Context

Every PR gets three AI reviewers: Cursor BugBot (`cursor[bot]`), OpenAI Codex
(`chatgpt-codex-connector[bot]`), and Claude Code (`claude[bot]`), plus a local
pre-push Codex autoreview. BugBot is advisory only for CI status: its check is
not required and its lag does not block (ADR 0007). Its comment content is not
fully advisory, though — `pr:feedback-state` treats `BUGBOT_BUG_ID` as an
actionable marker and blocks `pr:ready-state` until every flagged comment is
answered (`scripts/pr-feedback-state-core.mjs`); the dependabot auto-merge flow
separately cites BugBot's risk summary as advisory only. Codex and Claude run
on subscriptions the team already pays for other reasons. BugBot is the only
reviewer with its own bill.

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
  Claude 6 on 3 PRs. All three bots currently deliver accepted findings; the
  sample is too small and bursty to measure noise rates.
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

Read together: no candidate has a decisive quality edge. BugBot is the quiet,
precision-first member of the stack — a role Codex (deliberately P0/P1-only)
already fills. CodeRabbit and Greptile are the two credible replacements, and
both sit at or above BugBot on independent false-positive measurements.

### Cost at this repo's shape (1 PR-author seat, ~280 PRs/month, public repo)

| Option              | Pricing model                                 | Est. monthly cost                                        |
| ------------------- | --------------------------------------------- | -------------------------------------------------------- |
| BugBot (status quo) | ~$1.00–1.50/run, uncapped, re-review per push | ~$560–1,680                                              |
| CodeRabbit          | OSS tier free; else $24–30 for one seat       | **$0** (manual trigger; fallback $24–30)                 |
| Greptile            | $30/seat incl. 50 reviews, then $1/review     | ~$260 (review-on-open only); $540–1,100 (re-review/push) |
| Cubic               | Free unlimited on public repos                | $0                                                       |
| Graphite Agent      | Flat $20–40/month, unlimited reviews          | $20–40                                                   |
| Drop to two bots    | —                                             | $0, minus third-bot coverage                             |

CodeRabbit's public-repo terms were verified against the vendor's docs and
the installed org's billing page on 2026-08-18. The Open Source tier gives
public repos **Pro+ features free**, with no application step and no license
requirement; company-owned public repos included. Two limits shape it: OSS
rate limits are per-repository and popularity-scaled (1–10 reviews/hour),
and public repos with **fewer than 10 stars get no automatic reviews** —
every review is triggered manually (`@coderabbitai review`). This repo has 0
stars, so the $0 tier is manual-trigger-only; the trigger is a PR comment an
agent or babysit loop can post. Seats bill per Git identity that **opens** a
PR — pushing commits consumes nothing — so the paid fallback is one seat.
Observed at install: the org lands on a default 14-day Pro+ trial (3
reviews/developer/hour, the source of the first rate-limit refusal),
expiring 2026-09-01; an unsubscribed org then reverts to Free and its public
repos to the OSS treatment.

## Decision

Replace BugBot with CodeRabbit as the third advisory reviewer.

1. **Install** the CodeRabbit GitHub App on the repo (done 2026-08-18; the
   org sits on the default Pro+ trial until 2026-09-01). Decide before the
   trial ends: let the org revert to Free so the public repos ride the $0
   OSS tier with manual/scripted triggers, or pay for one Pro seat at
   $24–30/month for automatic reviews (5/hour nominal, fair-usage-degraded
   at this volume).
2. **Commit `.coderabbit.yaml`** before the first review lands: start from the
   assertive-adjacent default only if noise proves low; otherwise use the
   `chill` profile or the July 2026 `quiet` profile (critical findings inline,
   the rest summarized), `path_filters` excluding lockfiles and generated
   trees, and `auto_pause_after_reviewed_commits` tuned so agent fix-commit
   bursts do not burn review rounds.
3. **Parallel-run for ~2 weeks.** Switch BugBot to manual triggering
   (`bugbot run`) during the window to bound how often it runs — a trigger
   limit, not a spending cap; the account-level monthly spend limit is the
   only hard ceiling — compare both bots' findings on the same PRs, then
   disable BugBot in the Cursor dashboard.
   Until step 4 lands, CodeRabbit is not in the feedback-ledger bot roster, so
   its comments do not block `pr:ready-state` — triage them manually during
   the window.
4. **Update the bot rosters and docs in the cutover PR**:
   `scripts/pr-feedback-state-core.mjs`, `scripts/pr-feedback-state-claude.mjs`
   (severity/marker regexes — `BUGBOT_BUG_ID` retires, CodeRabbit's markers
   enter), `scripts/pr-ready-state-core.mjs`, `scripts/pr/review-process-metrics.mjs`,
   their tests, `docs/notes/pr-ready-state.md`,
   `docs/pr-checklists/ci-workflow-gates.md`,
   `docs/adr/0007-agent-quality-gate-and-merge-oracle.md` (its "Advisory bot
   lag (for example, Cursor)" line goes stale), and the comment in
   `.github/workflows/dependabot-auto-merge.yml`.
5. **Measure.** Run `scripts/pr/review-process-metrics.mjs` on before/after
   cohorts and re-check the fixed/won't-fix reply ratio per bot after ~40
   merged PRs. If CodeRabbit's accepted-finding rate is materially below
   BugBot's or noise stays high after tuning, revisit (fallbacks below).

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
  5 accepted findings in the last 40 merged PRs here. Free CodeRabbit
  dominates this option: same $0, coverage retained.
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

- Review spend drops from ~$560–1,680/month (est.) to $0, with a $24–30/month
  worst case. No component of the new stack meters per review run.
- The stack's third seat changes character from precision-quiet to
  high-recall. CodeRabbit's known weakness is verbosity; the quiet/chill
  profiles, path filters, and pause-after-reviewed-commits are the levers, and
  the feedback-ledger discipline (every finding gets a Fixed/Won't-fix reply)
  already forces per-finding triage. If noise stays high after tuning, that is
  a revisit trigger, not a live-with-it.
- No CodeRabbit tier auto-reviews every push at this repo's volume. The OSS
  tier requires manual triggers under 10 stars, and paid Pro's fair-usage
  ladder drops a developer identity past 60 reviews per 7 days to 1
  review/hour — this repo's ~65 PRs/week sits in that bucket. The workable
  pattern on any tier is triggered reviews at ready points
  (`@coderabbitai review`, label opt-in, or
  `auto_pause_after_reviewed_commits`); the parallel-run window should
  exercise it before BugBot is switched off.
- The cutover PR must sweep every live `cursor[bot]`/BugBot reference — the
  step-4 list above, re-verified by grep at cutover time rather than a fixed
  count, since references have already drifted once during this ADR's own
  review. `pr:feedback-state` severity regexes keyed on `BUGBOT_BUG_ID` retire
  with it.
- CodeRabbit is a new third-party GitHub App with repo read access and PR
  comment/review write access, steered by `.coderabbit.yaml` — and CodeRabbit
  resolves that file from the **source branch** of the PR under review,
  falling back to defaults when absent, so a PR can weaken or replace the
  profile that reviews it. Acceptable while the bot is advisory and gates
  nothing; before any CodeRabbit output ever feeds a required gate, protect
  the config (CODEOWNERS or CodeRabbit central configuration) and add
  marker-recognition tests (`@coderabbitai configuration` prints the
  effective settings).
- Watch item: `claude[bot]` review currently rides existing Max
  subscription spend. Anthropic's separate metered "Code Review" product bills
  $15–25/review — ruinous at this volume. If the GitHub Action review path is
  ever folded into that product, this ADR's math changes and the stack needs
  re-deciding.
- If CodeRabbit's public-repo terms change or throttling proves unworkable:
  first fallback is one paid CodeRabbit Pro seat ($24–30/month); second is
  Cubic (free, public repos); third is Graphite Agent (flat $20–40/month).

## Evidence

- BugBot usage pricing and mechanics: cursor.com/blog/may-2026-bugbot-changes
  (announced 2026-05-11, effective first renewal after 2026-06-08),
  cursor.com/blog/bugbot-updates-june-2026 (22% cheaper, incremental review
  opt-in), cursor.com/docs/bugbot (default full-PR re-review per push; no
  spend cap). Iteration-cost reports: forum.cursor.com thread
  "usage-based Bugbot pricing punishes iterative workflows" (May 2026).
- CodeRabbit pricing and public-repo terms: coderabbit.ai/pricing,
  docs.coderabbit.ai/management/plans, docs.coderabbit.ai/management/seat-assignment
  (seat = PR-opener; pushes free), kb.coderabbit.ai article 8856795235
  (open-source Pro activation). All fetched 2026-08-18.
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
  `docs/pr-checklists/ci-workflow-gates.md`; its `BUGBOT_BUG_ID` feedback-gate
  role per `scripts/pr-feedback-state-core.mjs`.
