---
title: Sentry Triage Pipeline
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
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
| Staleness watch          | `alerts/infra/sentry-ingest-watcher/`, `alerts/infra/monitoring.tf`                | Hourly Cloud Scheduler job, outside GitHub Actions     | A Cloud Monitoring freshness gauge; alerts `#alerts-infra`               |

Staleness watch is the only row that does not run in GitHub Actions, and that
is the whole point: a scheduler that dies silently cannot report its own death.
It measures the ingest run record on tracker issue #1282, **not** the ingest
workflow's conclusion — a run with the kill switch off or `SENTRY_TRIAGE_TOKEN`
absent still concludes `success` and never reaches the record writer, so the
record is the only signal that separates work done from exit code 0. Freshness
comes from the ISO timestamp inside the record body, never the comment's
`updated_at`, which any edit would move forward. The read is **unauthenticated**
and author-fenced: the repository is public, so the watcher holds no credential
and ignores any record not authored by the pipeline.
`sentry-triage-ingest-stale` fires when the last recorded ingest is older than
26h **or** when the gauge stops arriving, and the function publishes nothing
rather than guessing when it cannot read the record.
Ingest is the correct single canary: the triage, autofix, and archive legs
legitimately no-op for days when the queue is empty. Operator detail, including
how to prove the alert fires after an apply, lives in
[`alerts/infra/README.md`](../../alerts/infra/README.md).

The workflows own permissions, concurrency, branch guards, and exact
invocations. The scripts own parsing, idempotency, and state transitions. The
ADRs own the trust boundaries and rationale. Update those sources and this
runbook together when a contract changes.

Two shared modules sit under the stages above.
`scripts/sentry-triage-project-core.mjs` owns the VERDICT contract — markers,
parsing, and the two comment selectors every fence is asked through.
`scripts/sentry-triage-queue-contract.mjs` owns the QUEUE contract — the label
namespace, the untrusted-text neutralization, and the archive freshness-baseline
fields. `scripts/sentry-triage-requeue.mjs` is the one place a queue stub is ever
re-queued for triage; both producers call it and neither reconstructs the
sequence.

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
- A closed queue issue never rests on `sentry:needs-triage`. Stages may write
  that pairing transiently; ingest reopens it on its next run.
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
  `closed_at`: post the regression fence comment, shed the stale
  verdict/projection/autofix/archive labels, restore `sentry:needs-triage`, and
  reopen — in that order;
- closed match carrying `sentry:archived`: compare `lastSeen` against the
  archive freshness baseline in the stub's own body instead of `closed_at` (see
  the archive section below), falling back to `closed_at` when the body carries
  no parseable baseline;
- other closed match: leave it closed.

That write order is load-bearing at both ends, and no stage writes it by hand.
Every re-queue in the pipeline runs through one function,
`requeueQueueStub` in `scripts/sentry-triage-requeue.mjs`, which takes the CAUSE
as an argument and decides the fence from it. The fence goes first so no
interruption can leave a stub re-queued for triage without it; the state change
goes last so none can leave it open but unselectable. Every interruption point
then lands on a state that is inert or recoverable. On this path the fence post
is additionally guarded by an author-fenced identity check, so a retry completes
the sequence without duplicating it — a guard the caller declares, and one that
disarms itself whenever `lastSeen` does not parse, because the rendered body
then identifies no particular occurrence.

Missing or invalid timestamps fail toward re-triage. The strict timestamp gate
prevents Sentry's long-lived regressed substatus from causing a reopen/close
loop.

Ingest then sweeps the queue itself, independently of that run's Sentry
results: a closed stub that still carries `sentry:needs-triage` is reopened,
its stale verdict/projection/autofix/archive labels shed, and a fixed recovery
note posted. That pairing is unreachable, never a resting state — Stage B
selects open stubs only, and the regression gate above reopens a closed stub
only on fresh Sentry events. Several stages can write it (both `gh issue close`
compensation paths in the triage agent workflow when a close lands but its
response is lost, the archive leg's live-regression refusal, a crash inside
ingest's own reopen sequence, a hand-edit), so it is repaired once here from
observed state rather than guarded at each producer. Declining a stub means
removing `sentry:needs-triage`, not closing the stub while it still carries the
label.

The sweep re-reads each stub immediately before touching it and acts only if it
is still closed-and-needing-triage. The queue snapshot is taken before the whole
Sentry loop runs, so by the time the sweep reaches a given stub the snapshot can
be minutes old — long enough for a human to have declined it by removing the
label, which the sweep would otherwise put straight back. A failed re-read
leaves the stub stranded for the next run rather than recovering blind.

The sweep also skips any stub the regression path ATTEMPTED this run, not merely
the ones it re-queued. A Sentry-evidence re-queue that throws half-way would
otherwise be recovered by the fence-free bookkeeping path seconds later, inside
one run — a failed regression re-queue laundered into a bookkeeping one. The
chokepoint records the attempt before its first write, so the record exists
whether or not the writes do.

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

The agent posts that comment through `scripts/sentry-triage-agent-comment.mjs`,
its only write path. The wrapper accepts no issue argument, and does not take
the target from the environment either: bash arithmetic expansion assigns, so a
body containing `$((SENTRY_TRIAGE_COMMENT_ISSUE=1234))` rewrites the exported
variable while the agent's own command line is expanded, before Node starts.
The authoritative target is a JSON file that a trusted step pins under
`$RUNNER_TEMP` before the agent runs, left mode 0444 inside a mode 0555
directory. The env var survives as a cross-check only, and a disagreement
between the two refuses loudly rather than picking a winner.

Those modes are load-bearing, because **the agent can write files**. Claude
Code's permission rules match a command carrying an output redirection
(CHANGELOG v1.0.123), and `gh issue view --template` renders arbitrary
constructed text, so the read-only `gh` grants compose into "write any content
to any path this user can write" — including over the wrapper itself. The same
trusted step therefore copies the wrapper's whole runtime import closure into a
read-only `sentry-triage-tools` directory under `$RUNNER_TEMP`, and the agent's
`--allowedTools` grant names **that** path, never `scripts/`.
`scripts/sentry-triage-agent-comment.test.mjs` recomputes the closure from the
source and fails if the staging list stops matching it, so the attack cannot
move one file over. `scripts/sentry-mcp-broker.mjs` is staged alongside it even
though no grant names it: the rule for this job is that it executes nothing from
the agent-writable checkout, and a rule with an ordering caveat is one refactor
away from being wrong. The agent job's checkout also sets
`persist-credentials: false`, matching the autofix agent job.

**The agent job ends with the agent.** Immutable copies alone would not be
enough: the agent can append to `$GITHUB_ENV`, and
`BASH_ENV=<payload it wrote into the checkout>` is then exported to every later
step in the same job, whose bash sources that payload _before_ running its own
command. So the trusted follow-up is a separate `verdict` job — the shape
`sentry-autofix.yml` already uses for `select → agent → finalize`. A fresh job
means a fresh runner, a fresh checkout and a fresh environment, so nothing the
agent wrote to `$GITHUB_ENV`, `$GITHUB_PATH`, `$GITHUB_OUTPUT` or the checkout
exists there at all. Nothing crosses the job boundary: the handoff is the
verdict comment on the queue issue, which `verdict` re-reads from GitHub
through the same authoritative parser and validates against the closed verdict
enum. Its only inputs are the select job's `^[0-9]+$`-validated issue number
and `GITHUB_REPOSITORY`, and it holds `github.token` alone — no secret, no
`environment:`. Tests assert that the agent step is the last step of its job
and that no credential-bearing work follows it.

The wrapper also refuses a body that does not start with the
verdict marker and a body carrying its own authorship marker; it appends
`<!-- sentry-triage-agent-authored:v1 -->` and pipes the result into
`gh --body-file -` on stdin, handing `gh` an allowlisted environment that drops
the Claude OAuth token (and would drop a Sentry token, which since #1711 is not
in that environment to begin with). Deterministic
scripts and the agent share the `github-actions[bot]` identity, so that marker
— and the required verdict-marker prefix — are what separate agent text from
pipeline text.

**The body never touches the filesystem, and that is load-bearing.** An earlier
version wrote the validated body to a predictable `$RUNNER_TEMP` path and let
`gh` read it back. The agent can background a second permitted command
(`gh issue view … --template '<forged>' > that-path &`) and swap the content
inside the window between the check and the read; reproduced, it posted a
forged `Regressed in Sentry …` control comment past every fence. No check
closes a check-then-use window on a path the attacker can write — removing the
file removes the window. Do not reintroduce an intermediate file for the body.

**The Sentry credential is out of the agent's process env** (issue #1711).
The wrapper's verbatim-token refusal was never a leak control and must not be
described as one: the agent writes its own shell command, and bash expands and
transforms `$VAR` before the wrapper sees argv, so a spliced or split value
passes. Exact-value scanning is the wrong layer when the adversary controls the
shell. The fix removes the credential instead. See
[the credential broker](#the-credential-broker) below.

`CLAUDE_CODE_OAUTH_TOKEN` is the remaining credential in the agent's Bash, and
it stays there: `claude-code-action` places it in that process env itself
(`base-action/src/parse-sdk-options.ts` spreads the whole `process.env` into the
CLI subprocess, deleting only the OIDC request vars), and the pinned v1.0.183
offers no per-step or first-class MCP env forwarding to move it. Accepted with
its bounding: it is inference-only, so worst case is
inference-quota abuse, not repo or queue compromise, and any use lands in an
auditable public comment. Re-check on the next action bump.

### The credential broker

[ADR 0056](../adr/0056-agent-mcp-credential-broker.md) owns the decision and its
accepted residuals; this is the mechanism.

A trusted step in the triage job — before the agent, holding
`SENTRY_TRIAGE_TOKEN` step-scoped — starts `scripts/sentry-mcp-broker.mjs` on
loopback and mints an opaque per-run handle with `openssl rand -hex 32`. The
agent step receives the handle through `$GITHUB_ENV` and no Sentry credential.
Its Sentry MCP server runs with `--host 127.0.0.1:<port> --insecure-http` and
the handle as `SENTRY_ACCESS_TOKEN`; the broker validates the handle, swaps in
the real token and forwards to `https://us.sentry.io`. `--insecure-http` is
CLI-only, `SENTRY_URL` must be HTTPS and cannot combine with it, and
`SENTRY_HOST` takes a bare hostname — so the loopback wiring lives in the MCP
server's `args` and `SENTRY_HOST` is gone with the token. `$GITHUB_ENV` carries
the handle and never the token: it exposes a value to every later step, which is
right for an authenticator that only works against a loopback process on this
runner and wrong for a credential. The port has exactly one literal — the triage
job's `env: SENTRY_MCP_BROKER_PORT`. The broker requires it rather than
defaulting and the agent step interpolates it, so the two cannot drift into a
connection refused that only a live run would reveal.

**Out of the agent's env is not out of the agent's reach.** Every step runs as
`runner` and the agent holds `Read`, so `/proc/<pid>/environ` and
`/proc/<pid>/cmdline` of every process in the job are agent-readable — and the
step logs the broker's PID. `/proc/<pid>/environ` is the block captured at
`exec`, so deleting the variable inside the broker would not clear it; any
runtime scrub is theatre. The step therefore copies the token to a shell-local,
`unset`s the exported name, and pipes the value to the broker's **stdin** from
`printf`, a bash builtin: no env var, no argv, no temp file. The broker refuses
to start if it finds the token in its own exec-time environment. Do not rewrite
that pipe as a here-string or heredoc, where bash may materialise a file the
agent can read.

**Secrets reach steps through `env:`, never `${{ secrets.* }}` inside `run:`.**
GitHub expands `${{ }}` before writing the step script to `$RUNNER_TEMP`, so an
inline secret sits in plaintext on disk for the whole job — the same
same-UID-readable class as `/proc`. Audited across all 31 workflows: zero hits,
and a test in `scripts/sentry-mcp-broker.test.mjs` keeps this workflow that way.

The broker refuses anything that is not a GET on an allow-listed path with the
exact handle, and refuses to relay an upstream redirect (the MCP client would
follow it with the handle, off the broker). It also rewrites `links.regionUrl`
on organization payloads to its own origin — a correctness fix, not hardening:
Sentry returns `https://us.sentry.io` there, and both the MCP server's internal
`trace`/`span` path and its `find_organizations` output steer subsequent reads
off the broker with it. `links.organizationUrl` is left alone so verdict
comments keep real Sentry permalinks.

**The handle is not a second secret, and that is load-bearing.** Three
allow-listed tools (`find_projects`, `search_issues`, `search_events`) take an
agent-controlled `regionUrl`, and the MCP server's `validateRegionUrl` accepts
the base host plus a hardcoded `{sentry.io, us.sentry.io, de.sentry.io}`, keeps
only the host and re-applies its own protocol — `http` under `--insecure-http`.
So an injected agent can send its `Authorization` header to
`http://us.sentry.io/api/0/...` in cleartext, past the broker. Sentry egress is
not closed on the runner and this design does not assume it is. What leaks there
is the handle, which authenticates only to a `127.0.0.1`-bound process that dies
with the runner, so it is worth nothing off-runner or after the run.

There is deliberately **no stop step**. The triage job must end with the agent —
the agent can append `BASH_ENV=<payload it wrote>` to `$GITHUB_ENV`, and any
later step's bash would source that payload before its own command, escaping the
permission allowlist entirely. The broker bounds its own life with
`SENTRY_MCP_BROKER_TTL_SECONDS` instead (set to the job timeout), on a runner
that is destroyed with the job.

**Re-derive the path allowlist on a `@sentry/mcp-server` bump.** It is the
empirical closure of the granted tools, not a guess from tool names: point the
pinned MCP server at a capture server with
`--host 127.0.0.1:<port> --insecure-http`, drive every granted tool over stdio
(including `get_sentry_resource` across its whole `resourceType` enum and
`search_events` across every dataset) and collect the request paths. At 0.37.0
only five of the ten names in `--allowedTools` exist — `find_organizations`,
`find_projects`, `search_issues`, `search_events`, `get_sentry_resource`; the
other five are inert grants kept in case a bump restores them. A path the broker
refuses fails the triage leg loudly with the path named in its log, so a stale
allowlist is visible rather than silent.

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

A stub carries exactly one `sentry:verdict-*` label. The label edit adds the
new one and removes every other verdict label in the same call, so
re-dispatching an already-verdicted stub — the usual case after a human answers
a `needs-human` escalation — replaces the old verdict instead of stacking a
second one. The step then re-reads the stub and fails its own matrix job if
more than one survives. The shed list comes from the same `--parse-only` output
as the label, and covers the verdict namespace only: the wider re-queue shed
also clears the projection, autofix, and archive markers, which must survive a
verdict change. The digest warns about a double-verdicted stub but never fails
on one — it is the batch's single daily notification.

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

The regression refusal re-queues the stub through `requeueQueueStub`, declaring
cause `sentry-evidence`; that is what makes its comment open with the regression
fence line, so the verdict parser reads the previous round's verdict as stale.
The cause is the whole rule: one caused by new Sentry events must fence, because
any prior verdict described the old occurrence; one caused by bookkeeping — the
stranded-stub sweep above, which declares `bookkeeping` — must not, because
nothing about the Sentry issue changed and that verdict is still valid. Drop the
fence and a triage round that dies before posting lets the `verdict` job
re-apply the previous verdict and close the stub over a live regression. Add one
where it does not belong and a good verdict is discarded and re-triaged for
nothing. Neither call site can make that mistake by omission: an undeclared
cause refuses rather than defaulting either way, and `buildRegressedComment` —
the fence's one definition — has exactly one caller, inside the chokepoint.

The refusal will not re-queue a stub it cannot fence, and it decides that by
asking whether any verdict is still admissible — never by checking that a fence
comment exists. Presence is not admissibility: the refusal body is identical
across runs for one `lastSeen`, so an earlier run's fence can sit on the stub
underneath a verdict posted after it, where the parser correctly ignores it. Both
checks on this path run `selectVerdictComment`, the parser's own selector, so the
guard and the thing it guards against cannot drift apart. Both now live in the
chokepoint, so a future re-queue site inherits them instead of re-deriving them.

If approval disappears during the mutation window, the script rolls the queue
stub back and leaves it available for fresh triage. It does NOT un-archive the
Sentry issue: `archived_until_escalating` is the approved outcome and it
self-heals on escalation (see below). A later Sentry escalation also reopens and
cleans the queue stub. The best-effort Sentry link-back note uses an endpoint
absent from the public API reference; note failure is logged but never masks an
otherwise successful archive.

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
lost, and it aborts settlement and runs the same queue rollback as the
label-shed path.

Consuming before the close costs one thing, and the runbook below covers it. A
failure past the CAS cannot be retried by `workflow_dispatch`, whose guard needs
the approval label the run just spent. The stub is rolled back and the run fails
RED, leaving it with no approval, no `sentry:archived`, and no
`sentry:needs-triage` — in **one of two shapes**, because the rollback restores
the state the stub had before settlement rather than forcing it open:

- **open**, when the stub arrived open (the common case: a verdicted stub a human
  approved while it was still open);
- **closed**, when `sentry-triage-agent.yml` had already closed it. The
  reconciler deliberately does not reopen a stub this run did not close.

No stage picks up either shape: ingest skips an open match, and skips a closed
one whose `closed_at` postdates the regression; the triage agent selects on
`sentry:needs-triage`; archive needs the approval. It waits for a human. That is
deliberate, since the alternative ordering closes stubs over live regressions,
but it is a stranded state, not a self-healing one.
The Sentry issue stays archived throughout — the next paragraph says why, and
what that means for the re-approval the runbook asks for.

**A failed settlement leaves Sentry archived, on purpose.** Automation may only
ever set `archived_until_escalating` (ADR 0036), and that state is self-healing:
escalation resurfaces the issue by itself. So a run that archived successfully
and then failed to settle its queue stub has left Sentry in exactly the state a
SUCCESSFUL archive would have produced — the state a human already approved.
Reverting it bought nothing and cost a check-then-PUT race against Sentry's own
transitions: the check can still read `archived_until_escalating` while Sentry is
concurrently flipping a freshly-escalated issue to `unresolved/regressed`, and
the PUT then erases that regression signal. Since ingest finds old issues only
through `is:regressed`, the event would vanish from both systems. Only the queue
stub is rolled back.

That makes re-approval the standard recovery, so it carries its own guard. A run
over an issue that is ALREADY archived needs a baseline it can stand behind, and
refuses in both directions where it has none:

- **Stale** — the stub records a bound baseline and Sentry's `lastSeen` has moved
  past it (`skipped-stale-retry`). Settling would stamp the newer timestamp, and
  the reopen gate would never fire for the event in between.
- **Absent** — the stub records no baseline bound to this Sentry issue
  (`skipped-unbaselined-retry`). This is the state rollback deliberately leaves
  when a run archived Sentry and then failed before writing one, so it is the
  common case on re-approval. Adopting the retry's own read would take every
  event since the archive as "already accounted for". A baseline that is
  unparsable or names another issue counts as absent for the same reason.

Neither path mutates anything; both remove the approval so a bare re-dispatch
cannot skip the decision, and both write the refusal on the stub. Recovery is to
un-archive the Sentry issue and let it re-triage — the event is invisible to
ingest while it stays archived, since both queries match only unresolved issues.

**Queue rollback reconciles; it does not replay.** Every failure from the Sentry
PUT onward re-reads the stub and corrects only what live state actually shows to
be wrong — reopened if it is closed now and was open before, the terminal label
removed if present, and the body restored whenever its recorded baseline differs
from the pre-run one. Nothing consults a record of what the run believes it did,
because a rejected command is not proof its remote mutation did not happen: `gh
issue close` can close the stub and then lose its response. Any did-we-do-it flag
is wrong in exactly that case, and it is the case that matters. Reconciling is
idempotent by construction — a second pass finds nothing to correct — and it
re-reads once more afterwards, because a correction can be accepted and still not
take effect. When that final read still disagrees the run fails RED with one
`::error::` naming the stub's observed state.

The audit note is posted LAST, after the close, the terminal label and the
verification have all converged. Ordering rather than compensation: a note that
landed before a failing close would claim the issue was archived, and a later
successful re-approval would see that marker, suppress the real audit, and leave
the durable record showing the failed attempt's approver, timestamp and baseline.
A note that fails on its own is logged and tolerated — the settlement is already
correct, and the machine-readable record lives in the body.

Its at-most-once key is the archive GENERATION, not the Sentry issue: the marker,
the issue id, and the freshness baseline together. A stub can be archived,
regress, be reopened by ingest (which keeps its comments), be re-triaged,
re-approved and archived again, and the previous archive's note still matches
both the marker and the id — keying on those alone suppressed the new audit and
lost the new approver, timestamp and disposition. The baseline advances with
every genuine re-archive, so it distinguishes them; a true retry of the same
archive carries the same baseline and still dedups.

**Known residual: a run that dies cannot roll back its own queue writes.**
Reconciliation needs the process to survive. If the runner is cancelled or killed
mid-settlement — job timeout, OOM, a cancelled workflow — the stub can be left
part-settled, and the Sentry issue archived while the stub still carries
`sentry:approved-archive`. A later `workflow_dispatch` takes the already-archived
path, and because settlement consumes the approval before it writes the body, the
stub cannot yet carry a baseline — so that retry is REFUSED as
`skipped-unbaselined-retry` rather than recording its own read time. Nothing in
the dead run's window is absorbed, but nothing is recovered either: the Sentry
issue stays archived and is invisible to both ingest queries until someone acts.
Closing that would take a durable intent record written before the PUT, which is
not what this change does. The mitigation is operational: a killed archive run
leaves a red or cancelled run in Actions — un-archive the Sentry issue so ingest
re-queues it, then let the normal triage and approval cycle run.

**The archive records a freshness baseline.** Sentry's `substatus` lags a fresh
event, so the regressed/escalating refusal can pass while an event is already in
flight. The script captures the `lastSeen` it read before the mutation, re-reads
it once after the PUT, and — if it moved, or if that read-back fails or does not
parse — restores the Sentry issue, sheds the approval, and refuses without
settling. That matters because the archive's close necessarily postdates any
event that arrived inside the mutation window: a `closed_at` comparison would
evaluate false for that event forever and bury it until some later event
happened to arrive.

This refusal is the ONE path that still reverts the Sentry archive, and the
asymmetry is deliberate. A failed settlement leaves an archive whose premise
still holds — the human approved it and nothing contradicted that. A freshness
refusal is the opposite: it is positive evidence that an event landed which the
approver never saw, so the approval's premise is void. Leaving the archive there
would bury that event, because an `archived_until_escalating` issue matches
neither ingest query (both are `is:unresolved`) and a single already-counted
event does not reliably trip Sentry's escalation forecast. Reverting puts it back
in front of both.

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

The run record reports fetched, created, skipped, reopened, recovered, and
error counts. A nonzero recovered count means stubs were found closed while
still labeled `sentry:needs-triage`; a recurring one points at a producer worth
investigating, not at the sweep.
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
- **A red archive run whose stub is verdicted and carries neither
  `sentry:approved-archive` nor `sentry:archived` failed after it consumed the
  approval.** It can be **open or closed** — the rollback restores whichever
  state the stub had before settlement, so a stub `sentry-triage-agent.yml` had
  already closed comes back closed. Both are stranded; the closed one is the
  easier to miss, because it looks like an ordinary settled ledger entry until
  you notice it has no `sentry:archived`. Nothing retries either on its own, and
  no re-dispatch is possible — the guard needs the label the run spent. Only the
  stub was rolled back, so start from the run's one summary line — and read what
  it says about **Sentry** before assuming anything, because two dispositions
  produce this same stub shape:
  - **"stays archived_until_escalating"** — the archive landed. That is by
    design, not damage: it is the outcome the approver asked for, and escalation
    undoes it automatically. Carry on with the options below.
  - **"is in an UNKNOWN state"** — the PUT returned a 5xx or lost its response,
    so it may never have applied. **Open the Sentry issue and read its state
    before doing anything else.** If it is not archived, nothing was archived:
    the stub is simply unsettled, and the fix is a fresh approval once you are
    satisfied the issue should still be archived. If it is archived, treat it as
    the case above.

  Then check convergence. A `::notice::Rolled the queue stub … back` line means
  the stub converged and there is nothing to repair. An
  `::error::… did NOT converge` line names what it was observed to hold — fix
  that by hand: check the body carries the baseline it had BEFORE this run (or
  none, if it had none). Then choose the outcome explicitly — nothing chooses it
  for you:
  - to leave it archived, do nothing; the ledger entry is the only thing missing;
  - to settle the ledger, re-apply `sentry:approved-archive` — but expect a
    refusal, and read it rather than working around it. The rollback removed the
    baseline this run wrote, so unless an EARLIER archive left one the retry
    lands on an already-archived issue with nothing to compare against and
    refuses as `skipped-unbaselined-retry`: comment on the stub, approval
    removed again, nothing mutated. That is correct — there is no trustworthy
    value to adopt, and taking the retry's own read would hide every event since
    the archive. The way through is the next option;
  - to send it back through triage, add `sentry:needs-triage`, remove the
    `sentry:verdict-*` label, **reopen the stub if it came back closed**, and
    **un-archive the Sentry issue**. Leaving the approval off is not enough on
    its own: ingest skips an open stub, the triage agent selects on open stubs
    carrying `sentry:needs-triage` — so a closed one stays invisible however it
    is labelled — and while the issue stays archived it matches neither ingest
    query, so nothing re-surfaces it. Un-archiving puts it back in front of the
    pipeline,
    after which the next archive records a baseline it can stand behind.

- An archive **refusal** comment that says the archive could NOT be reverted is a
  different case from the above: the freshness refusal is the one path that does
  revert Sentry, and something moved the issue off `archived_until_escalating`
  before it could. Inspect that issue directly; the stub's state is correct but
  says nothing about where Sentry ended up.
- **A cancelled or killed archive run leaves nothing behind to fix it.**
  Rollback runs in-process, so a job that dies mid-archive never reconciles —
  see the known residual above. Before re-applying `sentry:approved-archive` to
  a stub whose last archive run was cancelled, timed out, or shows no summary
  line, open the Sentry issue and check its state for yourself. If it is already
  `archived_until_escalating`, re-applying the approval will refuse (the stub
  carries no baseline for it); un-archive the issue and let the normal cycle run
  instead.
- **A re-approval refused as `skipped-stale-retry`** means the Sentry issue is
  already archived and has recorded events newer than the baseline on the stub.
  Nothing was changed and the approval label was removed again. Re-applying it
  refuses again — the baseline is still older and the issue is still archived, so
  nothing about the comparison changes. Un-archive the Sentry issue instead: that
  puts it back in front of ingest, which re-queues it for triage, and the
  approval that follows records a baseline covering the newer activity.
- **A re-approval refused as `skipped-unbaselined-retry`** means the Sentry issue
  is already archived and the stub records no baseline bound to it — normally
  because the previous run archived Sentry and failed before writing one, and the
  rollback removed it. Nothing was changed and the approval was removed again.
  Re-applying it just refuses again, by design: there is no trustworthy value to
  compare against, and adopting the current `lastSeen` would treat everything
  since the archive as already accounted for. Un-archive the Sentry issue and let
  it re-triage; the next archive then records a baseline it can stand behind.
- **Trust the run's summary line about Sentry, not an assumption.** It says one
  of: the issue stays `archived_until_escalating` (the approved outcome), was
  NOT archived because the update was rejected, is in an UNKNOWN state because
  the request did not complete cleanly, or was never touched. Only the UNKNOWN
  case requires reading the Sentry issue to find out what happened.
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
pnpm sentry:requeue:test

# Read-only previews that require local credentials:
pnpm sentry:ingest --dry-run --lookback-days 8
SENTRY_TRIAGE_ISSUES='[123,456]' pnpm sentry:digest --channel '#engineering'
pnpm sentry:autofix:select --cap 2
```

For any contract change, also run the matching workflow/script tests,
`pnpm docs:index --check`, and `pnpm agent:context-check`.
