The exact-head closeout projection accepts untrusted or unbound signals and misses a valid CodeRabbit completion form. The workflow documentation also permits stale final projections and overstates duplicate suppression.

Full review comments:

- [P2] Reject untrusted closeout marker comments — /private/tmp/fx-1990/scripts/pr/pr-ready-state-core.mjs:772-774
  On a public PR, any outside commenter can post the command and current-head marker. This loop does not check the comment author or association, so it returns `requested` and prevents the babysitter from posting the legitimate closeout request. Accept markers only from an `OWNER`, `MEMBER`, `COLLABORATOR`, or a recognized repository agent.

- [P2] Require a head SHA before accepting a review — /private/tmp/fx-1990/scripts/pr/pr-ready-state-core.mjs:766-767
  When `headRefOid` is unavailable, `isCurrentReviewSignal` falls back to a timestamp and can classify an unbound CodeRabbit review as `reviewed`; the request path similarly accepts a marked SHA without comparing it to a current head. Because this gate claims exact-head evidence, it must fail closed as `missing` or `stale` unless a full current head SHA is available.

- [P2] Recognize CodeRabbit clean-summary completions — /private/tmp/fx-1990/scripts/pr/pr-ready-state-core.mjs:772-774
  CodeRabbit can finish an exact-head clean run by updating a top-level summary instead of creating a non-empty review record. This loop inspects issue comments only for the manual-request marker, so a trusted summary with a Run ID and full reviewed commit range remains `missing` or `stale`, causing a redundant request and an “Already reviewed” response. Recognize the bounded trusted clean-summary form with head and timestamp checks.

- [P2] Recheck the head immediately before posting — /private/tmp/fx-1990/.agents/skills/babysit-pr/SKILL.md:300-302
  If another push lands after this head lookup but before `gh pr comment`, the marker names the old head while the unbound CodeRabbit command reviews the then-current head. The projection can then miss the actual request and send another one. Re-read `headRefOid` immediately before the write and require it to equal the marker head.

- [P2] Treat the marker as best-effort duplicate suppression — /private/tmp/fx-1990/.agents/skills/babysit-pr/SKILL.md:310-312
  The marker does not make posting idempotent: two babysitters can both observe no marker and both create a comment before either write becomes visible, because GitHub issue comments have no conditional-create operation. Describe this as best-effort duplicate suppression and require a final refresh rather than promising idempotency.

- [P2] Extract review-signal logic from the near-hard core — /private/tmp/fx-1990/scripts/pr/pr-ready-state-core.mjs:750-755
  This classifier pushes `pr-ready-state-core.mjs` to 1,077 raw lines and 961 rough lines, an 84-line increase over the checked baseline and a near-hard result from the repository reporter. Extract the review-signal helpers into a focused module instead of extending this existing hotspot. See `docs/pr-checklists/code-health.md:176-183`.

- [P2] Add CodeRabbit fields to the canonical JSON example — /private/tmp/fx-1990/docs/notes/pr-ready-state.md:351-355
  The field description introduces `codeRabbitReviewSignal`, but the preceding expected JSON example still omits both `gates.codeRabbitReviewSignal` and the top-level signal. Agents or consumers that use this canonical example will miss the new closeout state. Update the example as required by `AGENTS.md:90-95`.

- [P2] Run the final projections after the closeout request — /private/tmp/fx-1990/docs/notes/pr-ready-state.md:399-402
  The ordered workflow runs the projection pair in step 5 and posts the CodeRabbit request here in step 8, but step 10 does not explicitly require another pair afterward. If the requested review posts findings after the earlier sweep, the agent can report all-clear from stale projections. Move the request before the final pair or require both projections again after the closeout refresh, per `AGENTS.md:90-95`.
