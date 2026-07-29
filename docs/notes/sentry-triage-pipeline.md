---
title: Sentry Triage Pipeline
status: active
owner: eng
canonical: true
last_verified: 2026-07-29
scope: ci/process
doc_type: runbook
review_interval_days: 90
garden_lane: operator-runbooks
---

# Sentry triage pipeline

This is the operator reference for the Sentry queue, triage, projection,
autofix, and archive workflows defined by
[ADR 0036](../adr/0036-sentry-triage-pipeline.md) and
[ADR 0038](../adr/0038-sentry-central-plane-verdict-projection.md). It records the contracts
and recovery procedures that are not obvious from the implementation.

Do not use this note as a rollout-status snapshot. Check
[tracker #1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282),
the current workflow runs, and the repository Actions variables before
enabling or operating a later stage.

## Authority and stage map

| Stage                    | Owner                                                                              | Schedule or trigger                                    | Writes                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Ingest                   | `.github/workflows/sentry-triage-ingest.yml`, `scripts/sentry-triage-ingest.mjs`   | 05:30 and 13:30 UTC daily; manual dispatch from `main` | Redacted queue issues and the ingest run record                          |
| Triage                   | `.github/workflows/sentry-triage-agent.yml`, `.github/prompts/sentry-triage.md`    | 07:55 UTC weekdays; manual dispatch must select `main` | One verdict comment per selected issue                                   |
| Deterministic settlement | `scripts/sentry-triage-project-core.mjs`, `scripts/sentry-triage-project.mjs`      | After each triage batch                                | Verdict labels, queue closure, and optional owning-repo issue projection |
| Autofix                  | `.github/workflows/sentry-autofix.yml`, `.github/prompts/sentry-autofix.md`        | 08:30 UTC weekdays; manual dispatch from `main`        | A scoped branch and PR for eligible local code fixes                     |
| Archive                  | `.github/workflows/sentry-triage-archive.yml`, `scripts/sentry-triage-archive.mjs` | Human approval label or manual dispatch from `main`    | Sentry `archived_until_escalating` state and a queue audit record        |

The workflows own permissions, concurrency, branch guards, and exact
invocations. The scripts own parsing, idempotency, and state transitions. The
ADRs own the trust boundaries and rationale. Update those sources and this
runbook together when a contract changes.

The triage row states an operator requirement, now backed by a mechanical
guarantee. Every secret-bearing job in these workflows declares the
`sentry-pipeline` GitHub Environment, whose deployment-branch policy names `main`
explicitly (Terraform in `terraform/github-environment.tf`, issues #1289 and
#1649 — an explicit pattern, never `protected_branches`, which is inert in this
repo and fails open). GitHub refuses such a job on any non-main ref server-side — before it
starts, and regardless of what the branch's workflow file says — so a feature-ref
`workflow_dispatch` can no longer reach the pipeline's secrets by stripping the
in-workflow `if: github.ref == 'refs/heads/main'` guard. Still select `main`; the
environment is the backstop, not a licence to dispatch off-main. The shared
`CLAUDE_CODE_OAUTH_TOKEN` deliberately stays a repo-level secret (it is consumed
by `.github/workflows/claude.yml` on feature-branch `pull_request` events, which a
main-only environment would break); it is inference-only, so its residual
exposure is bounded to inference-quota abuse.

## Non-negotiable invariants

- This repository is public. Queue issues and verdicts must never reproduce
  Sentry titles, messages, stack frames, parameterized URLs, user data, or
  other payload text. They may contain redacted coordinates, abstract
  diagnoses, and Sentry permalinks.
- The triage agent has read-only Sentry access. Its only write is one structured
  verdict comment; deterministic code validates that comment and performs all
  labels, closures, and projections.
- Missing, invalid, stale, or unauthenticated verdicts fail loudly and retain
  `sentry:needs-triage` for retry.
- Closing a queue issue never resolves or archives its Sentry issue.
- Autofix opens a PR only. Required CI, review, and merge remain human gates.
- Archiving requires an explicit human-applied
  `sentry:approved-archive` label and a separate write-scoped credential.
- Sentry read, projection, autofix, and archive credentials stay isolated and
  are provisioned through the platform Terraform stack. Never use
  `gh secret set` or the GitHub UI as an activation shortcut.

## Queue contract

Ingest queries unresolved new and regressed issues for the `mento-labs`
organization. The project set, mapping, pagination, default lookback, and noise
heuristics are owned by `scripts/sentry-triage-ingest.mjs`; do not duplicate
those lists here.

Each Sentry group maps to one queue issue:

```text
[sentry] <SHORT-ID> (<project>, <level>)
```

The body starts with `<!-- sentry-triage:v1 -->` and contains only the
redacted machine record plus a validated `https://*.sentry.io` permalink:

```yaml
short_id: "GOVERNANCE-MENTO-ORG-51"
sentry_issue_id: "6197137101"
project: "governance-mento-org"
level: "error"
status: "unresolved"
events: 42
users: 7
first_seen: "2026-07-01T00:00:00Z"
last_seen: "2026-07-14T10:00:00Z"
permalink: "https://mento-labs.sentry.io/issues/6197137101/"
```

The Sentry `shortId` is the idempotency key. Ingest scans all queue states in
bulk:

- no matching queue issue: create one;
- open match: leave it open;
- closed match with a regression whose `lastSeen` is newer than
  `closed_at`: reopen it, remove stale verdict/projection/archive labels, and
  restore `sentry:needs-triage`;
- closed match carrying `sentry:archived`: compare `lastSeen` against the
  archive freshness baseline in the stub's own body instead of `closed_at` (see
  the archive section below), falling back to `closed_at` when the body carries
  no parseable baseline;
- other closed match: leave it closed.

Missing or invalid timestamps fail toward re-triage. The strict timestamp gate
prevents Sentry's long-lived regressed substatus from causing a reopen/close
loop.

The namespace is separate from the development backlog:

| Label                        | Meaning                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `sentry-triage`              | Durable queue membership                                               |
| `sentry:needs-triage`        | Awaiting a current verdict                                             |
| `sentry:candidate-noise`     | Title matched an in-memory noise heuristic; raw text was not published |
| `sentry:verdict-code-fix`    | Code change is the recommended disposition                             |
| `sentry:verdict-config-fix`  | Configuration or infrastructure change is recommended                  |
| `sentry:verdict-upstream`    | Upstream or transient issue; no repo fix                               |
| `sentry:verdict-needs-human` | A human decision is required                                           |
| `sentry:projected`           | An actionable external verdict was projected to its owning repo        |
| `sentry:approved-archive`    | Human approval to archive the Sentry issue                             |
| `sentry:archived`            | Archive workflow settled the approved issue                            |

Queue issues must never carry `agent-ready`, `agent-active`,
`needs-grooming`, or `in-pr`.

## Verdict and settlement contract

The triage workflow selects at most ten oldest pending queue issues and runs at
most two triage jobs in parallel. For each issue, the agent posts one comment
starting with `<!-- sentry-triage-verdict:v1 -->`, a YAML block, and a short
redacted diagnosis:

```yaml
verdict: code-fix # code-fix | config-fix | upstream-transient | needs-human
confidence: medium # high | medium | low
affected_repo: mento-protocol/monitoring-monorepo
summary: <one redacted line>
root_cause: |
  <one to three redacted lines>
proposed_action: |
  <one to three redacted lines>
duplicate_of: [] # Sentry SHORT-IDs only
```

A `needs-human` verdict also includes a concrete `human_question`, one to
three `hypotheses`, an `investigated` list, and an
`escalation_reason`. A missing or placeholder `human_question` is invalid:
an escalation must be decision-ready, not “please look.”

The deterministic parser accepts only comments from
`github-actions[bot]`. After a regression reopen, it accepts only a verdict
newer than the latest pipeline-authored regression comment. It then applies
the label and transition below:

| Verdict              | Label                        | Queue outcome      | Downstream action                                                                                                                  |
| -------------------- | ---------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `code-fix`           | `sentry:verdict-code-fix`    | Close as completed | Project to an allowlisted external repo, or leave a visible projection-skipped note; eligible local issues may later enter autofix |
| `config-fix`         | `sentry:verdict-config-fix`  | Close as completed | Project to an allowlisted external repo, or leave a visible projection-skipped note                                                |
| `upstream-transient` | `sentry:verdict-upstream`    | Close as completed | None                                                                                                                               |
| `needs-human`        | `sentry:verdict-needs-human` | Keep open          | Human answers the recorded question and decides the next action                                                                    |

Every deterministic close records that the ledger issue will reopen on a
future Sentry regression. A missing verdict after a scheduled run is an
operational failure signal, not “no issues found.”

### External verdict projection

[ADR 0038](../adr/0038-sentry-central-plane-verdict-projection.md) limits projection to
actionable `code-fix` and `config-fix` verdicts whose `affected_repo` is
one of the script's allowlisted owning repositories. Projection runs
serialized after the triage matrix so two related verdicts cannot race to
create duplicate issues.

The projector uses a fine-grained PAT with Issues read/write on only those
repositories. It keys reuse to the Sentry short ID and the projector account's
authorship. Rotating the token through a different account can break reuse and
must be treated as a migration. On `main`, an absent
`SENTRY_PROJECTION_TOKEN` makes projection a visible no-op and queue
settlement continues. A non-`main` manual triage dispatch deliberately
withholds the token; an actionable external verdict is re-queued and the job
fails so the next `main` run can project it safely.

### Local autofix PRs

Autofix considers only local `code-fix` stubs without an existing fix PR,
caps each run at two, and uses a GitHub App scoped to Contents and Pull
requests on this repository. The fix agent receives no Sentry credential.
Deterministic selection and finalization enforce the issue/branch/diff
contract. `ui-dashboard/vercel.json` denies `git.deploymentEnabled` for
`sentry-autofix/*`, so an autofix branch's untrusted diff never gets a Vercel
deployment (and its production-linked secrets) before human review — a trust
boundary earlier than the path-aware skip script (ADR 0019, issue #1452).

The LLM agent runs in a **read-only `agent` job** (contents:read + issues:read,
no App token) and hands its whole working tree to a separate **trusted
`finalize` job** as an artifact (issue #1373). Finalize re-derives the changed
set and re-runs the diff guard against its own pristine clone — trusting no
agent-provided metadata — before it mints the App token, pushes, and opens the
PR. So a prompt-injected agent that exfiltrates its job's `github.token` gets a
read-only token that cannot write issues, push, or open PRs; only the Claude
OAuth inference token stays exposed (inherent to the action, out of scope for
#1373). A live-FS symlink tripwire in the agent job rejects a symlink-exfil diff
before it can reach the handoff artifact.

Do not use manual dispatch as a probe: there is no dry-run mode. Dispatch from
`main`; an off-`main` dispatch is a deliberate no-op. On `main`, when the
stage is enabled and the issue is eligible, dispatch creates a real branch and
PR. The workflow never merges it.

If the `code-fix` verdict is shed while the PR is being opened (a regression
re-queue in ingest's separate concurrency group), finalization withdraws rather
than marking the stub fixed. It re-reads the verdict immediately before and
after writing the `sentry:fix-pr-opened` marker; on a shed verdict it closes the
just-opened PR (the selector dedups on an open autofix PR too, so skipping the
label alone would not free the stub), removes any marker it already applied, and
comments that the fix was not finalized. A closed autofix PR carrying no marker
is that intentional regression-re-queue outcome, not an orphaned run; an
unconfirmable close fails the run loudly rather than leaving a stale PR that
would suppress the re-fix.

That re-read also checks the verdict comment's **identity**, not just the label's
presence (a **generation token**, issue #1506). The trusted select job captures
the numeric id of the verdict comment the fix was based on and threads it to
finalize through the matrix; finalize re-selects the live verdict comment and
withdraws if the id no longer matches. This catches an ABA a re-triage can create
inside the window — sheds the label, then re-adds it with a **new** verdict
comment — which label-presence alone cannot see. Reconcile entries carry no token
(they relink a prior run's PR, whose originating verdict id select never saw), so
they stay on the label-presence guard; the token is never sourced from the agent
job or the handoff artifact.

### Human-approved archive

Archiving is independent of the verdict. An authorized human may apply
`sentry:approved-archive` to any verdicted queue issue. The archive workflow
revalidates the live approval and verdict before and after the Sentry mutation,
refuses a currently regressed/escalating issue, and uses the documented issue
update API to set `archived_until_escalating`. It then records the approver
and timestamp, applies `sentry:archived`, and closes the queue issue.

If approval disappears during the mutation window, the script attempts to
restore the Sentry issue to unresolved and leaves the queue issue available for
fresh triage. A later Sentry escalation also reopens and cleans the queue stub.
The best-effort Sentry link-back note uses an endpoint absent from the public
API reference; note failure is logged but never masks an otherwise successful
archive.

Ingest and archive run in separate concurrency groups, so two narrow races
remain after the label re-reads above. Both are closed mechanically (issue
#1371); a shared `concurrency:` group is deliberately NOT the fix, because
GitHub keeps only one pending run per group and would silently drop a second
human-approved archive queued behind a running ingest.

**Consuming the approval is a compare-and-swap.** Settlement deletes
`sentry:approved-archive` through
`DELETE /repos/{repo}/issues/{n}/labels/sentry:approved-archive` — not
`gh issue edit --remove-label`, which swallows the 404 — and only closes the
stub if that delete succeeded. The label is the single token both writers
contend for: ingest's regression reopen sheds it too, so a 404 means this run
lost, and it aborts settlement and runs the same Sentry restore as the
label-shed path.

Consuming before the close costs one thing, and the runbook below covers it. A
failure past the CAS cannot be retried by `workflow_dispatch`, whose guard needs
the approval label the run just spent. The script reverts its own Sentry archive
and fails RED, so nothing stays archived off a spent approval — but the stub is
then open with no approval, no `sentry:archived`, and no `sentry:needs-triage`.
No stage picks that up: ingest skips an open match, the triage agent selects on
`sentry:needs-triage`, and archive needs the approval. It waits for a human.
That is deliberate, since the alternative ordering closes stubs over live
regressions, but it is a stranded state, not a self-healing one.

**Rollback reconciles; it does not replay.** Every failure from the Sentry PUT
onward re-reads both systems and corrects only what live state actually shows to
be wrong — Sentry back to its pre-run status if and only if it still holds
exactly what this run would have written, the stub reopened if it is closed now
and was open before, the body stamp and the terminal label removed if present.
Nothing consults a record of what the run believes it did, because a rejected
command is not proof its remote mutation did not happen: `gh issue close` can
close the stub and then lose its response, and a PUT can archive and then lose
its response. Any did-we-do-it flag is wrong in exactly those cases, and they
are the cases that matter. Reconciling is idempotent by construction — a second
pass finds nothing to correct — and it re-reads once more afterwards, because a
correction can be accepted and still not take effect. When that final read still
disagrees the run fails RED with one `::error::` naming what both systems were
observed to hold.

**Known residual: a run that dies cannot compensate itself.** Reconciliation
needs the process to survive. If the runner is cancelled or killed between the
archive PUT and the rollback — job timeout, OOM, a cancelled workflow — nothing
runs, and the Sentry issue can be left `archived_until_escalating` while the
stub still carries `sentry:approved-archive`. A later `workflow_dispatch` then
takes the already-archived path and records ITS OWN read time as the baseline,
absorbing anything that landed in the dead run's window. Closing this would take
a durable intent record written before the PUT, which is not what this change
does. The mitigation today is operational: a killed archive run leaves an
approved, open, unarchived-looking stub and a red or cancelled run in Actions —
check the Sentry issue before re-approving.

**The archive records a freshness baseline.** Sentry's `substatus` lags a fresh
event, so the regressed/escalating refusal can pass while an event is already in
flight. The script captures the `lastSeen` it read before the mutation, re-reads
it once after the PUT, and — if it moved, or if that read-back fails or does not
parse — restores the Sentry issue, sheds the approval, and refuses without
settling. That matters because the archive's close necessarily postdates any
event that arrived inside the mutation window: a `closed_at` comparison would
evaluate false for that event forever and bury it until some later event
happened to arrive.

**The baseline lives in the stub BODY, never in a comment.** It is written into
the same yaml block ingest creates the stub with, as
`archive_baseline_last_seen` plus the Sentry issue id it mutated, and the write
happens before anything marks the stub settled. Placement is the entire trust
boundary here, and it is structural rather than cryptographic. The Stage B
triage agent is an LLM reading attacker-controlled Sentry payloads, and
`.github/workflows/sentry-triage-agent.yml` grants it
`Bash(gh issue comment <its stub>:*)` — its comments post as
`github-actions[bot]`, on that exact stub. So no author, marker, or issue-id
check applied to a **comment** is worth anything: a prompt-injected payload
satisfies all three and plants a far-future baseline, after which every later
regression of that Sentry issue is skipped indefinitely. The agent's allowlist
contains no tool that edits an issue body, the autofix agent gets no shell at
all, and the archive leg's deterministic zero-LLM step is the only writer that
ever rewrites one. Moving the field removes the forgery surface instead of
authenticating inside it, which a shared secret could only match, never beat.

Ingest still requires the recorded issue id to match the Sentry issue the stub
tracks; a baseline naming another issue, or naming none, describes some other
archive and reopens the stub for re-triage instead of gating it. Because the
dedup scan already fetches every stub body, reading the baseline costs no extra
request — and there is no comment list to page through.

The baseline is therefore load-bearing, and the archive fails **closed** without
one. If Sentry's pre-mutation `lastSeen` does not parse, the run refuses before
touching anything — no PUT, no queue mutation, the approval label intact so the
stub stays re-dispatchable. If the post-PUT read-back stops parsing, the run
reverts the archive and refuses with its own distinct reason, because a
malformed read cannot prove that no event landed. Neither case may proceed: an
unusable baseline would send ingest back to the `closed_at` comparison, and
nothing downstream can distinguish that from a stub archived before this
contract existed. The `closed_at` fallback in ingest exists only for those older
stubs, never as a path a fresh archive is allowed to take.

## Operator runbook

### Inspect live state first

Use all three surfaces:

1. [tracker #1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282)
   for activation gates and the rolling ingest run record;
2. Actions history for the four workflows above;
3. repository Actions variables for the literal enable flags.

The run record reports fetched, created, skipped, reopened, and error counts.
Scheduled workflow failures also route through the repository's main-failure
notifier. Triage produces a per-run `#engineering` digest. Absence of an
expected record or digest is itself a signal.

### Provision and change controls

All values originate in the operator-held, gitignored
`terraform/terraform.tfvars` and are mirrored by the `platform` Terraform
stack:

| Stage           | Terraform inputs                                                          | GitHub surface                                                                   | Minimum privilege                                                  |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Ingest + triage | `sentry_triage_token`, `claude_code_oauth_token`, `sentry_triage_enabled` | `SENTRY_TRIAGE_TOKEN`, shared `CLAUDE_CODE_OAUTH_TOKEN`, `SENTRY_TRIAGE_ENABLED` | Sentry Issue/Event, Project, and Organization read only            |
| Projection      | `sentry_projection_token`                                                 | `SENTRY_PROJECTION_TOKEN`                                                        | GitHub Issues read/write on the allowlisted owning repos only      |
| Autofix         | `autofix_app_id`, `autofix_app_private_key`, `sentry_autofix_enabled`     | `AUTOFIX_APP_ID`, `AUTOFIX_APP_PRIVATE_KEY`, `SENTRY_AUTOFIX_ENABLED`            | GitHub App Contents and Pull requests read/write on this repo only |
| Archive         | `sentry_archive_token`, `sentry_archive_enabled`                          | `SENTRY_ARCHIVE_TOKEN`, `SENTRY_ARCHIVE_ENABLED`                                 | Separate Sentry Issue/Event read/write token                       |
| Settings audit  | `platform_settings_audit_token`                                           | `PLATFORM_SETTINGS_AUDIT_TOKEN`                                                  | GitHub Administration **read-only** on this repo only              |

All five Sentry-pipeline-exclusive secrets above — `SENTRY_TRIAGE_TOKEN`,
`SENTRY_PROJECTION_TOKEN`, `AUTOFIX_APP_PRIVATE_KEY`, `SENTRY_ARCHIVE_TOKEN`,
`PLATFORM_SETTINGS_AUDIT_TOKEN` — are `github_actions_environment_secret`
resources on the `sentry-pipeline` GitHub Environment
(`terraform/github-environment.tf`), not repo-level Actions secrets. They are
still count-gated on the same tfvars, so an unset value plans and applies cleanly
and the stage stays inert. `CLAUDE_CODE_OAUTH_TOKEN` remains a repo-level secret
(`terraform/github-secrets.tf`) because it is shared with `claude.yml`. Adding a
new Sentry-pipeline secret means: add its `github_actions_environment_secret`
here, and add `environment: sentry-pipeline` to every job that reads it.

To change a stage:

1. update only the relevant tfvars;
2. run `pnpm infra:plan` and inspect the platform-stack diff;
3. obtain explicit human approval;
4. run `pnpm tf apply platform` from a clean `main` checkout;
5. verify a bounded live case and the expected observability record.

To pause ingest/triage, autofix, or archive, set that stage's named
`*_enabled` tfvar to `"false"` and reapply. Projection has no enable flag: set
`sentry_projection_token = ""` and reapply. Confirm the plan removes
`SENTRY_PROJECTION_TOKEN`; subsequent external verdicts then record the
visible projection-skipped outcome instead of creating owning-repo issues.
Never widen the read-only token or reuse it for archive. Treat
`CLAUDE_CODE_OAUTH_TOKEN` replacement as a shared-secret rotation and verify
the existing Claude PR workflow after applying it.

The **settings audit** row is not a pipeline stage — it powers
`.github/workflows/platform-settings-drift.yml`, a daily read-only check
(issue #1564) that the repo default workflow-token permission stays `read`
(pinned by `github_workflow_repository_permissions.default_read`, #1557). It is
the ONLY platform credential deliberately given a CI surface with Administration
scope, and it is **read-only** — it can never change a setting. Provision
`platform_settings_audit_token` as a fine-grained PAT with **Administration:
Read** (nothing else) on this repo, then apply the platform stack. Until it is
set the check no-ops; on drift it opens a `drift-detection` + `stack:platform`
issue. Do not point this at the write-capable `github_token` (which stays
local-only) or grant Administration to the autofix App. Fine-grained PATs
expire (≤1 year); when it lapses the check fails loudly ("rotate the audit
token") rather than reporting false drift, so rotate it on that signal.

#### GitHub Environment rollout (issue #1289)

Moving the five Sentry-pipeline-exclusive secrets behind the `sentry-pipeline`
Environment is a one-time, ordered migration. A new `environment:` workflow
reference AUTO-CREATES an unprotected Environment if the protected one does not
already exist (see docs/terraform.md, "GitHub Environments"), and several of the
secrets are live, so roll it out Terraform-FIRST:

1. Apply `terraform/github-environment.tf` FIRST — the
   `github_repository_environment.sentry_pipeline` environment plus its
   `github_repository_environment_deployment_policy` (`branch_pattern = "main"`)
   and the five `github_actions_environment_secret` resources — while the
   repo-level `github_actions_secret` copies in `github-secrets.tf` are still
   present. The env secrets duplicate the repo ones (GitHub allows a secret at
   both scopes), so nothing breaks. The environment and its branch pattern must
   land in the SAME apply: `custom_branch_policies = true` with no pattern
   refuses every deployment.
2. Verify (Settings → Environments → `sentry-pipeline`) that the deployment
   branch rule is an explicit `main` pattern — **not** "Protected branches",
   which is inert here and fails open (#1649) — that admin bypass is disabled,
   and that the expected environment secrets are present. The identity contract
   hash-pins both the environment and the deployment-policy blocks, so a
   _source_ change to either fails CI; a live settings change made in GitHub's UI
   is caught only by the next manual `pnpm tf apply platform` (no drift job
   monitors the platform stack's environment settings).
3. Prove the gate, do not assume it: from a throwaway branch, have a non-admin
   writer push a workflow that declares `environment: sentry-pipeline` and
   reports only whether a secret is present (never its value). It must be
   refused. #1649 exists because this step was skipped.
4. Only THEN land the workflow `environment: sentry-pipeline` references and the
   removal of the repo-level `github_actions_secret` blocks from
   `github-secrets.tf`, and apply. The protected environment already exists, so
   nothing auto-creates unprotected; the repo-level copies are destroyed and the
   jobs read the environment secrets.

Apply step 4 at a quiet time (avoid the 05:30 / 05:41 / 07:55 / 08:30 UTC cron
windows) so no scheduled run coincides with the repo-secret destroy. The
platform PAT must carry the **Environments: Read/write** fine-grained
permission or the environment-secret writes 403 (`terraform/providers.tf`).

### Backfill or retry

- After an ingest outage longer than the default lookback, dispatch
  `Sentry Triage Ingest` from `main` with `lookback_days` set to an
  integer from 1 to 90. Existing short IDs are skipped, so a wider window is
  safe.
- For a read-only preview, run
  `pnpm sentry:ingest --dry-run --lookback-days 30` with a separately
  provided `SENTRY_TRIAGE_TOKEN`.
- A failed or invalid triage verdict retains `sentry:needs-triage`; rerun the
  agent workflow after correcting the underlying failure. Manual
  `issue_number` dispatches must target an open queue issue.
- A refused autofix is terminal until a human reviews the refusal, corrects
  any transient cause, and removes `sentry:fix-refused` from the queue issue.
  Then dispatch `Sentry Autofix` from `main` for that issue or let the next
  scheduled run select it. A later Sentry regression clears the marker
  automatically.
- A projection without its token closes the queue issue with an explicit
  skipped note. Provision the token and re-triage only when the owning-repo
  issue is still required.
- **A red archive run whose stub is open, verdicted, and carries neither
  `sentry:approved-archive` nor `sentry:archived` failed after it consumed the
  approval.** Nothing retries this on its own, and no re-dispatch is possible —
  the guard needs the label the run spent. The run already reconciled both
  systems back to their pre-run state, so look for its one summary line. A
  `::notice::Rolled back …` line means both sides converged and there is nothing
  to repair. An `::error::… did NOT converge` line names what Sentry and the
  stub were each observed to hold — fix that side by hand first: take the Sentry
  issue off `archived_until_escalating`, and check the stub body carries no
  `archive_baseline_last_seen`. Then choose the outcome explicitly — nothing
  chooses it for you:
  - to archive it after all, re-apply `sentry:approved-archive`;
  - to send it back through triage, add `sentry:needs-triage` **and** remove the
    `sentry:verdict-*` label. Leaving the approval off is not enough on its own:
    ingest skips an open stub, and the triage agent selects on
    `sentry:needs-triage`, which nothing here restores.
- An archive refusal comment that says the archive **could NOT be reverted**
  means something moved the Sentry issue off `archived_until_escalating` while
  the run held it. Inspect that issue directly; the queue stub's state is
  correct but says nothing about where Sentry ended up.
- **A cancelled or killed archive run leaves nothing behind to fix it.**
  Rollback runs in-process, so a job that dies mid-archive never reconciles —
  see the known residual above. Before re-applying `sentry:approved-archive` to
  a stub whose last archive run was cancelled, timed out, or shows no summary
  line, open the Sentry issue and confirm it is not already
  `archived_until_escalating`. Re-approving over a silent archive is what
  re-baselines off the retry's own read time and buries the window's events.
- Do not manually close a pending queue issue to hide a failure. Fix the
  workflow or make a documented human disposition.

## Verification

These checks are offline unless noted:

```bash
pnpm sentry:ingest:test
pnpm sentry:digest:test
pnpm sentry:project:test
pnpm sentry:autofix:select:test
pnpm sentry:autofix:finalize:test
pnpm sentry:archive:test

# Read-only previews that require local credentials:
pnpm sentry:ingest --dry-run --lookback-days 8
SENTRY_TRIAGE_ISSUES='[123,456]' pnpm sentry:digest --channel '#engineering'
pnpm sentry:autofix:select --cap 2
```

For any contract change, also run the matching workflow/script tests,
`pnpm docs:index --check`, and `pnpm agent:context-check`.
