---
title: Sentry Triage Pipeline
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
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

The triage row states an operator requirement, not a mechanical guarantee.
The triage workflow does not yet guard its dispatch ref: a feature-ref dispatch
checks out that ref while holding the read-only Sentry token and issue-write
workflow token. Always select `main`.
GitHub Environment enforcement for this surface is tracked in
[#1289](https://github.com/mento-protocol/monitoring-monorepo/issues/1289).

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
