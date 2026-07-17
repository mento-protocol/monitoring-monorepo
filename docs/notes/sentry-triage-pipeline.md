---
title: Sentry Triage Pipeline
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
scope: ci/process
---

# Sentry triage pipeline

Operational reference for the staged Sentry issue triage/autofix pipeline
decided in [ADR 0036](../adr/0036-sentry-triage-pipeline.md). This note is
intentionally sectioned by pipeline stage: each stage's issue lands its own
section here so later stages (phased mutations, the push leg) extend this file
instead of rewriting it. Phase 1 = Stage A (deterministic ingest) + Stage B
(read-only triage verdicts).

## How it fits together

The life of a Sentry issue, in one paragraph: an error event lands in one of
the org's six Sentry projects; twice a day the deterministic ingest turns every
new or regressed issue group into one redacted queue issue in this repo; 45
minutes later the triage agent picks the oldest pending batch, investigates
each via read-only Sentry access, and posts a structured verdict; a
deterministic workflow step validates the verdict, applies the matching label,
and — for every bucket except `needs-human` — closes the queue issue (state
reason: completed) with a fixed closing comment, so the queue reads as
work-in-flight instead of a growing archive; humans consume verdicts by
label — nothing is fixed, archived, or resolved **in Sentry** automatically in
Phase 1; closing only ever touches this repo's local ledger issue, and a
closed queue issue reopens automatically (Stage A's regression-reopen path)
once the underlying Sentry issue records events newer than the close.

### Architecture

```mermaid
flowchart LR
    subgraph SENTRY["Sentry — mento-labs org (6 projects)"]
        SE["error events,<br/>grouped into issues"]
    end

    subgraph GHA["GitHub Actions — this repo"]
        ING["<b>Stage A — ingest</b><br/>sentry-triage-ingest.yml<br/>deterministic script, 2×/day"]
        SEL["<b>Stage B — select</b><br/>6 oldest pending,<br/>oldest-first"]
        AGT["<b>Stage B — triage agents</b><br/>claude-code-action, ≤2 parallel<br/>read-only Sentry MCP"]
        LBL["<b>deterministic verdict step</b><br/>parse comment → validate →<br/>apply label (no LLM authority)"]
        PROJ["<b>deterministic projection step</b><br/>code-fix/config-fix + external<br/>owning repo → owning-repo issue<br/>(Issues-write, no LLM authority)"]
        CLOSE["<b>deterministic close step</b><br/>code-fix/config-fix/upstream →<br/>close (completed); needs-human<br/>stays open (no LLM authority)"]
    end

    subgraph QUEUE["GitHub Issues — machine ledger"]
        QI["queue issues<br/><code>[sentry] SHORT-ID (project, level)</code><br/>redacted coordinates only<br/>closed once verdicted (except needs-human)"]
    end

    subgraph OWN["Owning repos — product teams (ADR 0038)"]
        REPOS["frontend-monorepo ·<br/>mento-analytics-api ·<br/>minipay-dapp<br/>(human-readable projected issues)"]
    end

    subgraph TF["Terraform platform stack"]
        SEC["SENTRY_TRIAGE_TOKEN (read-only)<br/>SENTRY_TRIAGE_ENABLED (kill switch)"]
        SECP["SENTRY_PROJECTION_TOKEN<br/>(Issues R/W, 3 owning repos)"]
    end

    subgraph OBS["Observability"]
        TRK["run record →<br/>tracker #1282"]
        CIF["workflow failures →<br/>#ci-failures"]
        ENG["per-run verdict digest →<br/>#engineering<br/>(fast-follow #1336, in flight)"]
    end

    HUM["humans — review verdicts,<br/>act per owning repo"]

    SE -- "REST: new + regressed<br/>(lookback window)" --> ING
    ING -- "1 redacted issue per group,<br/>idempotent by SHORT-ID" --> QI
    QI --> SEL --> AGT
    SE -. "full payload read at<br/>triage time (read-only)" .-> AGT
    AGT -- "verdict comment" --> QI
    LBL -- "sentry:verdict-* label" --> QI
    AGT --> LBL
    LBL --> PROJ
    PROJ --> CLOSE
    PROJ -- "actionable verdict,<br/>allowlisted owning repo" --> REPOS
    PROJ -- "sentry:projected + link comment" --> QI
    CLOSE -- "close (completed),<br/>verdicted buckets only" --> QI
    SEC -. "gates + authenticates" .-> ING & SEL
    SECP -. "authenticates (Issues-write)" .-> PROJ
    ING --> TRK
    GHA -.-> CIF
    LBL --> ENG
    QI --> HUM
    REPOS --> HUM
```

### Process flow — life of one Sentry issue

```mermaid
flowchart TD
    EV["Error event in any of the 6<br/>Sentry projects"] --> GRP["Sentry groups it into an<br/>issue (SHORT-ID)"]
    GRP --> POLL["Ingest run (05:30 / 13:30 UTC)<br/>queries new + regressed issues"]
    POLL --> KNOWN{"queue issue with this<br/>SHORT-ID exists?"}
    KNOWN -- "no" --> CREATE["create queue issue<br/>sentry-triage + sentry:needs-triage<br/>(+ sentry:candidate-noise if heuristic hits)"]
    KNOWN -- "open" --> SKIP["skip (already queued)"]
    KNOWN -- "closed + regressed +<br/>events since close<br/>(lastSeen &gt; closedAt)" --> REOPEN["reopen, shed stale verdict +<br/>projected labels,<br/>re-add sentry:needs-triage"]
    KNOWN -- "closed, otherwise" --> STAY["skip (stays closed:<br/>not regressed, or regression<br/>already triaged before close)"]
    CREATE --> PEND["pending in queue"]
    REOPEN --> PEND
    PEND --> BATCH["next agent run picks ≤6<br/>oldest pending (06:15 / 14:15 UTC)"]
    BATCH --> INV["agent investigates:<br/>Sentry payload (read-only MCP)<br/>+ repo checkout for ui-dashboard"]
    INV --> VC["posts ONE redacted verdict comment<br/>(yaml: verdict/confidence/repo/<br/>summary/root cause/duplicates)"]
    VC --> VALID{"deterministic step:<br/>valid verdict?"}
    VALID -- "no" --> FAIL["job fails loudly;<br/>issue keeps sentry:needs-triage<br/>→ retried next run"]
    VALID -- "yes" --> SWAP["label swap →<br/>sentry:verdict-&lt;verdict&gt;"]
    SWAP --> DIGEST["run digest → #engineering<br/>(fast-follow #1336, in flight)"]
    SWAP --> BUCKET{"verdict bucket"}
    BUCKET -- "code-fix / config-fix" --> PROJ["deterministic projection step:<br/>affected_repo an allowlisted<br/>owning repo + token set?"]
    PROJ -- "yes" --> FILE["file owning-repo issue<br/>(idempotent by SHORT-ID),<br/>label stub sentry:projected,<br/>comment projected URL"]
    PROJ -- "no (this repo / unrecognized /<br/>token absent → visible skip)" --> CLOSESTEP
    FILE --> OWNFIX["product team fixes in<br/>the owning repo<br/>(Phase 3 #1279: scoped fix-PR)"]
    FILE --> CLOSESTEP
    BUCKET -- "upstream-transient" --> CLOSESTEP
    BUCKET -- "needs-human" --> REV["human review<br/>(queue stub stays OPEN —<br/>the one excluded bucket)"]
    CLOSESTEP["deterministic close step<br/>(closing comment links the<br/>projected issue when present)"] --> CLOSED["queue stub closed (completed);<br/>reopens automatically on<br/>Sentry regression"]
```

Nothing in Phase 1 mutates Sentry or any codebase: the writes anywhere are the
queue issue (create/reopen/close), the verdict comment, the label, the
notifications, and — for actionable verdicts against an external owning repo —
a human-readable **issue** projected into that repo (Issues-write only, no code;
see "Verdict projection" below). Closing a queue issue never touches Sentry —
the underlying Sentry issue keeps whatever status it already had; only the
local ledger entry closes.

## Queue contract (v2)

Stage A (`scripts/sentry-triage-ingest.mjs`, `.github/workflows/sentry-triage-ingest.yml`)
turns every new or regressed Sentry issue across the `mento-labs` org into
exactly one GitHub queue issue in this repo. The contract below is normative —
Stage B (the read-only triage agent) and later phases build against it. Do not
change it without updating the ingest script and this doc together.

**v2 privacy rule (why this contract looks the way it does):** this repo is
PUBLIC, so raw Sentry payload text — issue titles, culprits, messages — would
publish production error data (ADR 0036). No payload-derived text may appear
anywhere in a queue issue: not in the title, not in the yaml block, not in
the human-readable section, not in comments. Queue issues carry only
Sentry-assigned identifiers, counters, and timestamps; triage reads the
actual payload in Sentry via the permalink. The raw title is still used
IN-MEMORY for noise classification — only the resulting label is public.

### Source

- Sentry org `mento-labs` (SaaS, region `https://us.sentry.io`), 6 projects
  across 4 repos: `analytics-mento-org`, `analytics-api`, `app-mento-org`,
  `governance-mento-org`, `minipay-dapp`, `reserve-mento-org`. Every project's
  issues funnel into this repo's queue via one org-wide endpoint — fix PRs in
  the owning repo are a later phase, not part of Stage A.
- `GET https://us.sentry.io/api/0/organizations/mento-labs/issues/`, paginated
  via `Link` response headers.
  - New issues: `query=is:unresolved firstSeen:-<N>d` — the lookback `<N>`
    defaults to 8 days and is configurable (integer 1-90) via the
    `SENTRY_TRIAGE_LOOKBACK_DAYS` env var, the `--lookback-days` CLI flag
    (flag wins), or the workflow's `lookback_days` dispatch input.
  - Regressed issues: `query=is:unresolved is:regressed`
- `Authorization: Bearer $SENTRY_TRIAGE_TOKEN` (read-only token; Stage A never
  writes to Sentry).

### Title

```text
[sentry] <SHORT-ID> (<project>, <level>)
```

Example: `[sentry] GOVERNANCE-MENTO-ORG-51 (governance-mento-org, error)`

`<SHORT-ID>` is the Sentry issue's own `shortId` (e.g.
`GOVERNANCE-MENTO-ORG-51`). The Sentry issue title is payload text and never
appears here (v2 privacy rule). The queue title is the sole idempotency key —
see below.

### Idempotency

Before creating an issue, search existing queue issues (**all states**) for a
title whose first whitespace-delimited token after the `[sentry]` prefix
equals `<SHORT-ID>`:

- **Open match** → skip.
- **Closed match, Sentry issue is regressed, and its `lastSeen` is strictly
  newer than the queue issue's `closed_at`** → reopen it, comment
  `Regressed in Sentry (last seen <ts>)`, re-add `sentry:needs-triage`, and
  remove any stale `sentry:verdict-*` labels plus the stale `sentry:projected`
  marker — the old verdict/projection described the old occurrence, and a
  reopened issue must read as awaiting triage, not as carrying a verdict (or a
  projection claim) and needs-triage at once. If the re-triage round lands on
  an actionable verdict again, the projection step re-applies the marker,
  idempotently reusing the same owning-repo issue. The timestamp gate exists
  because Sentry keeps `substatus=regressed` for days after a regression:
  without it, a verdict-closed stub would loop reopen → re-triage → close on
  every ingest run until Sentry flips the substatus. Missing or unparsable
  timestamps fail open toward triage (reopen) — a wrongly skipped regression
  is silent, a wrongly reopened one merely re-triages.
- **Closed match, otherwise** → skip (stays closed): not regressed, or a
  regression whose events all predate the close and were therefore already
  triaged before the ledger entry closed.
- **No match** → create.

At ~31 new issue groups/week org-wide, the ingest script does this as one
bulk scan per run (not one search per issue): it pages through the complete
`sentry-triage` label set, all states, with no result cap — a capped scan
would silently start duplicating older regressed issues once the queue
outgrows the cap.

**Queue hygiene counterpart:** the deterministic close step (verdict contract
below) closes verdicted queue issues so the tracker stays readable. To this
scan, a queue issue closed by the verdict-close step is just another "closed
match" — and the `lastSeen`-vs-`closed_at` gate above is what makes the
pairing loop-free: a regression with events newer than the close reopens for
re-triage, while Sentry's days-long `substatus=regressed` tail on an
already-triaged occurrence leaves the ledger entry closed.

### Labels

Every queue issue carries `sentry-triage` (the durable queue-namespace
marker, kept for the issue's lifetime) plus `sentry:needs-triage`.
`sentry:candidate-noise` is added when the raw Sentry title matches a noise
heuristic: `^Blocked '` (CSP reports), `TimeoutError`, `Failed to fetch`,
`Failed to load chunk`, `AbortError`. The classification runs in-memory
during ingest; the raw title itself never renders anywhere (v2 privacy
rule).

Queue issues never get the dev-backlog labels (`agent-ready`,
`needs-grooming`, etc.) — this is a disjoint label namespace so the two agent
queues can't cross-claim each other's work.

The ingest script idempotently bootstraps every pipeline label on each run
(`gh label create --force`), including the verdict labels Stage B will use
before Stage B exists, plus the `sentry:projected` marker the verdict-projection
step applies (see "Verdict projection" below): `sentry-triage`,
`sentry:needs-triage`, `sentry:candidate-noise`, `sentry:verdict-code-fix`,
`sentry:verdict-config-fix`, `sentry:verdict-upstream`,
`sentry:verdict-needs-human`, `sentry:projected`.

### Body

````text
<!-- sentry-triage:v1 -->

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

[View in Sentry](<permalink>)
````

The yaml block deliberately has NO `title` or `culprit` fields, and the
human-readable section is only the permalink (v2 privacy rule above). All
Sentry-derived strings that do render are still treated as untrusted,
attacker-reachable text as defense in depth — never executed or evaled, and
neutralized before embedding:

- control characters and newlines collapsed;
- every backtick replaced with a look-alike character, so a hostile value can
  never close the yaml code fence early;
- a zero-width space inserted after every at-sign, so mention syntax like
  `@user` or `@org/team` can never become a live GitHub mention;
- yaml string fields hard-bounded at 200 chars ("truncate hard").

The permalink is only rendered as a clickable link when it parses as an
`https://\*.sentry.io` URL; otherwise the body falls back to plain text.

### Kill switch

The workflow's first step checks the repo Actions variable
`SENTRY_TRIAGE_ENABLED`. Anything other than the literal string `true` exits 0
with a `::notice::` — no Sentry or GitHub API calls made. As defense in depth,
the script itself also no-ops gracefully (exit 0, `::notice::`) when
`SENTRY_TRIAGE_TOKEN` isn't set, whether invoked from CI or locally.

### Run record

Each run posts (or updates a single rolling comment on, matched via the
`<!-- sentry-triage-ingest:run-record:v1 -->` marker) the tracker issue
([#1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282))
with a UTC timestamp and counts: fetched / created / skipped-existing /
reopened / errors. A missing run record — the workflow ran but the comment
never landed — is itself the alert signal for Phase 1; combined with the
schedule-failure Slack notifier (`.github/workflows/notify-slack-on-main-failure.yml`,
which this workflow is registered in), that covers both "the run crashed" and
"the run silently stopped mattering." A run with per-issue mutation errors
still posts the run record but exits nonzero, so the failure notifier fires
for systemic failure modes (bad token permission, API outage) too.

## Verdict contract

The read-only triage agent — `.github/workflows/sentry-triage-agent.yml`, driven
by the prompt in `.github/prompts/sentry-triage.md` — is Stage B of the Sentry
triage pipeline (ADR 0036). For each pending queue issue (`sentry-triage` +
`sentry:needs-triage`) it investigates the underlying Sentry issue (Sentry MCP,
read-only token + the repo checkout for `analytics-mento-org`) and posts exactly
one verdict comment. It never fixes code, never writes to Sentry, and never
opens PRs. Responsibility is deliberately split: **the LLM agent's only write is
the verdict comment; the verdict label is applied by a deterministic workflow
step** that parses the comment (see below) — the agent holds no label-editing
capability at all.

### Verdict comment

The comment starts with the marker `<!-- sentry-triage-verdict:v1 -->`, followed
by a fenced ` ```yaml ` block, followed by a short (≤ 15 line) human-readable
diagnosis.

Redaction rule: this repository is public, so the diagnosis (and every yaml
field) must never quote Sentry payload text, stack frames, parameterized URLs,
or user data verbatim — abstract descriptions plus the Sentry permalink only.
This mirrors the Stage A queue contract, which likewise keeps Sentry titles and
culprits out of queue-issue bodies.

```yaml
verdict: code-fix # code-fix | config-fix | upstream-transient | needs-human
confidence: medium # high | medium | low
affected_repo: mento-protocol/frontend-monorepo
summary: <one line>
root_cause: |
  <1-3 lines>
proposed_action: |
  <1-3 lines>
duplicate_of: [] # list of Sentry SHORT-IDs (e.g. GOVERNANCE-MENTO-ORG-51), possibly empty
```

Field semantics:

- `verdict` — the classification (see the four values below). Required.
- `confidence` — `high` / `medium` / `low`. Low confidence and `needs-human`
  both mean "a person should look before any action is taken".
- `affected_repo` — the owning repo for the error, e.g.
  `mento-protocol/frontend-monorepo` (app/governance/reserve), `mento-protocol/mento-analytics-api`
  (analytics-api), `mento-protocol/monitoring-monorepo` (analytics-mento-org →
  `ui-dashboard/`), or `mento-protocol/minipay-dapp`.
- `summary` — one line describing the error.
- `root_cause` — 1–3 lines. For non-`analytics-mento-org` projects the agent has
  no source checkout, so this is derived from Sentry evidence alone and says so.
- `proposed_action` — 1–3 lines describing the fix/config change/escalation.
- `duplicate_of` — Sentry SHORT-IDs of other queue issues in the same
  culprit/message family; empty when none found. The duplicate search spans
  **all** issue states (`gh issue list --state all`) — verdicted queue issues
  auto-close (see "Queue closing" below), so the ledger's triage history lives
  mostly in closed issues.

### Verdict label application (deterministic)

After the agent finishes, a deterministic step in
`.github/workflows/sentry-triage-agent.yml` (not the agent) reads the newest
marker-bearing comment on the queue issue, extracts the yaml `verdict` value,
validates it against exactly the four allowed values, removes
`sentry:needs-triage`, and adds the mapped verdict label. If no valid verdict
comment exists, the step fails the job loudly (`::error::` + exit 1) and leaves
`sentry:needs-triage` in place so the next scheduled run retries the issue — a
failed triage never silently strands an unlabeled issue.

**Single parser:** the parse itself is delegated to
`scripts/sentry-triage-project.mjs --parse-only` — the exact same
selection/validation code the verdict-projection step runs — so labeling and
projection can never disagree about what a verdict says. The projection step
additionally receives the label step's validated verdict back (`--verdict`)
and fails loudly if its own read ever differs (only possible if the issue
changed between steps), never silently skipping.

**Authorship fence:** only comments authored by the pipeline's own GitHub
Actions bot (`github-actions`; REST shape `github-actions[bot]`) are
considered — both for verdict comments and for regression-reopen comments.
This repo is public, so without the fence any drive-by commenter could paste a
marker-bearing comment and drive labels, closes, and (once the projection PAT
exists) cross-repo issue creation, or stale-out a legitimate verdict with a
fake regression comment. Comments with a missing/unknown author fail closed.

**Regression fence:** a reopened regression still carries the previous round's
verdict comment (Stage A's reopen path sheds labels, not comments). The step
therefore only accepts a verdict comment that is strictly newer than the
newest regression-reopen comment (`Regressed in Sentry (last seen …)`,
compared by comment `createdAt`); a stale pre-regression verdict is treated
exactly like a missing one — fail loudly, keep `sentry:needs-triage` — so a
regressed issue can never be re-labeled or re-closed off a verdict that never
investigated the regression. On first triage (no regression comment) the
fence is a no-op.

The verdict **value** maps to the verdict **label** as follows (label names are
owned by the Stage A queue contract / ingest bootstrap):

| verdict              | label                        |
| -------------------- | ---------------------------- |
| `code-fix`           | `sentry:verdict-code-fix`    |
| `config-fix`         | `sentry:verdict-config-fix`  |
| `upstream-transient` | `sentry:verdict-upstream`    |
| `needs-human`        | `sentry:verdict-needs-human` |

Note the deliberate asymmetry: the verdict value `upstream-transient` maps to the
label `sentry:verdict-upstream` (not `-upstream-transient`).

### Queue closing (deterministic)

Immediately after the label swap, in the same deterministic step and using the
same already-validated `verdict` value (never agent-authored text), the step
closes the queue issue for every bucket except `needs-human`:

| verdict                                        | queue issue                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `code-fix`, `config-fix`, `upstream-transient` | closed (`gh issue close --reason completed`)                                          |
| `needs-human`                                  | stays **open** — the one bucket that wants human eyes; a human closes it after acting |

The closing comment is fixed and deterministic — its only variables are the
validated four-value verdict enum and, for `code-fix`/`config-fix`, a
projection note built from the projection step's closed-enum status plus the
`gh`-returned owning-repo issue URL (never agent-authored comment text):

```text
Triage complete: <verdict>. Ledger entry closed; reopens automatically on Sentry regression.
```

For `code-fix`/`config-fix` the comment additionally records the projection
outcome between the verdict word and "Ledger entry closed" — the linked
owning-repo issue when one was filed/reused, or an explicit "Projection skipped
(SENTRY_PROJECTION_TOKEN not provisioned)." while the PAT is absent (visible,
not silent). See "Verdict projection" below.

This is queue hygiene only: it closes this repo's local ledger issue, never
the underlying Sentry issue (Sentry archival stays Phase 2a, human-approved,
a separate write-scoped token — see "What Phase 2 does with verdicts" below).
The regression-reopen path (Stage A's idempotency scan, above) is this step's
exact counterpart: a queue issue closed here reopens automatically once the
underlying Sentry issue records an event newer than the close (`lastSeen`
strictly newer than the queue issue's `closed_at`). That timestamp gate is
what keeps the pair loop-free — Sentry holds `substatus=regressed` for days,
so without it an already-triaged, just-closed stub would re-match the
regressed query and cycle reopen → re-triage → close every run.

For `code-fix`/`config-fix` verdicts against an external owning repo, the
verdict-projection step (ADR 0038, "Verdict projection" below) runs between the
label swap and this close, files the owning-repo issue, and the closing comment
links it.

**One-off backfill (queue hygiene, 2026-07):** activation-era queue issues
that already carry a non-`needs-human` verdict label predate this closing step
and need a single manual sweep, run once after this change merges — see
"Backfill (queue hygiene closing, one-off)" in the operator runbook below for
the exact command.

### How to read a verdict

- `code-fix` — a code change in the owning repo would fix it (bug, unhandled
  edge, bad assumption).
- `config-fix` — a configuration/infra change fixes it (CSP allowlist, env var,
  alert rule, third-party setting) — no application code change needed.
- `upstream-transient` — external outage/flake/user-environment noise; no action
  in our repos.
- `needs-human` — ambiguous root cause, a security-sensitive surface
  (auth/payments/keys), or conflicting evidence. The agent is instructed to pick
  this whenever uncertain — a wrong confident verdict is worse than an
  escalation.

A missing verdict comment on a `sentry:needs-triage` issue after a scheduled run
means the triage agent did not run or did not finish — treat it as a signal,
not as "no issues found".

### Observability (run record + per-run Slack digest)

ADR 0036's dominant failure mode is _unauditable automation going dark_, so the
pipeline surfaces itself two ways, and a break in either turns a run red:

- **Run record (Stage A).** Every ingest run updates the rolling
  `<!-- sentry-triage-ingest:run-record:v1 -->` comment on tracker issue
  [#1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282)
  with counts (see the Stage A "Run record" section). A missing update is a
  dead-man-switch signal.
- **Per-run Slack digest (Stage B).** After every triage run that processed at
  least one queue issue, the `digest` job in `sentry-triage-agent.yml` posts a
  deterministic digest to Slack `#engineering` so verdict review needs zero
  GitHub polling. It is a pure CONSUMER of the verdict contract — no LLM, no
  label writes, no Sentry — driven by the collector `scripts/sentry-triage-digest.mjs`:
  for each batch issue it reads the current labels and the latest
  pipeline-bot-authored `<!-- sentry-triage-verdict:v1 -->` comment (the same
  authorship fence as the label/projection steps — a drive-by marker comment
  cannot feed text into the digest) and renders one line per issue
  (`<SHORT-ID> (<project>) — <verdict> (<confidence>): <summary>`, linked to the
  queue issue), with counts by verdict plus a `failed triage` bucket for batch
  issues still carrying `sentry:needs-triage` (their triage matrix job died —
  kept visible, never hidden). The job runs `if: always()` gated on a non-zero
  select count, so it posts even when some triage matrix jobs failed (partial
  visibility) but stays silent on empty batches and kill-switch no-ops.

  Security: verdict summaries are agent-authored from untrusted Sentry data, so
  every free-form value embedded in the payload is neutralized and Slack-escaped
  with the same `& < >` escape the main-failure notifier uses
  (`.github/workflows/notify-slack-on-main-failure.yml`) — the escape that
  makes Slack mention/link syntax (`<!channel>`, `<@U…>`) inert. The bot token
  (`secrets.TF_VAR_SLACK_BOT_TOKEN`, `chat:write.public`, reused — no new
  secret) reaches only the posting step; the channel is hardcoded in the
  workflow (changing it is a one-line PR). A digest-job failure fails the run,
  which `notify-slack-on-main-failure.yml` (where this workflow is registered)
  surfaces to `#ci-failures`.

### What Phase 2 does with verdicts (forward-looking)

Phase 1 is read-only by design: verdicts and labels only, no fixes and no Sentry
writes (ADR 0036, Stage B). Later phases consume these labels, each gated on the
previous phase's measured verdict accuracy — not on elapsed time:

- `sentry:verdict-upstream` → candidate for the human-approved archive step
  (Phase 2a), which may only ever set Sentry issues to
  `archived_until_escalating`, never hard-resolve.
- `sentry:verdict-code-fix` → candidate for scoped fix-PR generation in the
  owning repo (Phase 2b+), which runs through required CI and independent
  (Codex) review like any other PR.
- `sentry:verdict-config-fix` and `sentry:verdict-needs-human` → stay with a
  person.

## Verdict projection

The central queue is a machine ledger; the human artifact for an actionable
finding lives where the product team works. **Verdict projection** (ADR 0038)
is the deterministic, no-LLM step that turns a `code-fix`/`config-fix` verdict
for an EXTERNAL owning repo into a proper, readable issue in that repo. It runs
in `.github/workflows/sentry-triage-agent.yml` AFTER the verdict-label step and
BEFORE the queue-close step, driven by `scripts/sentry-triage-project.mjs`
(`gh` I/O + orchestration + CLI; the pure logic lives in
`scripts/sentry-triage-project-core.mjs`, re-exported by the entry; tests in
`scripts/sentry-triage-project.test.mjs`).

It is a pure CONSUMER of the verdict contract — it re-reads the stub's title,
yaml body, and latest `<!-- sentry-triage-verdict:v1 -->` comment through the
SAME authoritative parser the label step uses (`--parse-only` above), including
the authorship and regression fences, and never re-fetches Sentry, runs an
LLM, or touches the verdict/label logic. The workflow hands the label step's
validated verdict back via `--verdict`; if the script's own read ever differs
(only possible when the issue changed between steps), it fails loudly rather
than silently skipping.

**When it projects.** Only `code-fix`/`config-fix`; `needs-human` and
`upstream-transient` never leave the queue. The verdict's `affected_repo` is
UNTRUSTED agent text, validated against a FIXED allowlist —
`mento-protocol/frontend-monorepo`, `mento-protocol/mento-analytics-api`,
`mento-protocol/minipay-dapp`. Anything else is a no-op:
`mento-protocol/monitoring-monorepo` (this repo — its errors are fixed here)
quietly, an unrecognized value with a `::warning::` (treated as this repo). This
allowlist is the entire trust boundary for the cross-repo write.

**What it files.** Title `Sentry: <summary>`; body = only the
redaction-governed verdict-contract fields (summary, root cause, proposed
action, confidence, possible duplicates), the Sentry permalink, a back-link to
the queue stub, and a fixed footer — no raw Sentry payload is fetched or copied.
Every agent-derived string is neutralized the same way the Stage A queue body is
(control chars stripped, backticks defanged so a hostile value can't break a
code fence, `@` defanged so it can't become a live GitHub mention); multi-line
fields render inside fenced blocks so embedded markdown is inert; the SHORT-IDs,
permalink, and back-link are shape-/scheme-validated before they render.

**Idempotency.** Before creating, the owning repo is searched across **all**
states (SHORT-ID ANDed with a fixed footer phrase as a sharp pre-filter, 200
result cap; the hidden `<!-- sentry-projection:v1 SHORT-ID -->` back-link
marker is the authoritative match — accepted only in the body's LEADING marker
block (the first line plus any coalescing alias lines directly under it), and
HTML-comment openers are defanged in every rendered field so a spoofed marker
inside verdict text can never impersonate it) for an existing projected
issue; a match is reused, never duplicated. A genuine match
must ALSO be **authored by the projector identity itself** (the PAT's own
login, resolved via `gh api user` under the projection token) — anyone with
Issues access in an owning repo could pre-create a marker-shaped issue, and a
hostile one must not steal the projection slot. This makes projection safe
across regression reopen → re-triage cycles (the same SHORT-ID reuses the same
owning-repo issue). A **closed** match is reopened first, with a fixed
regression comment, so the regression resurfaces for the product team instead
of silently linking a closed issue.

**Duplicate coalescing.** When the verdict's `duplicate_of` names a SHORT-ID
that already has a genuine projection (same leading-marker + author checks),
that issue is reused instead of filing a second owning-repo issue for the same
underlying bug: the new SHORT-ID is persisted as an **alias comment** on the
reused issue — its first line is the marker (the authoritative alias
predicate, accepted only from the projector identity) and its visible part
carries the SHORT-ID, the footer phrase, the queue-stub back-link (the
`in:body,comments` search pre-filter matches visible text) **and the new
occurrence's full rendered verdict fields** (summary/root cause/proposed
action, neutralized and bounded like the projected body). `duplicate_of` is a
same-culprit/message **family** signal, not a confirmed exact duplicate, so
nothing is discarded: the alias comment is the new finding's record, with an
explicit invitation to split it into its own issue if it is actually
distinct. An alias is deliberately a comment, never a body edit: comment
creation is an atomic APPEND, so two parallel matrix jobs coalescing
different SHORT-IDs onto the same issue can never lose each other's alias the
way concurrent read-modify-write body edits could (GitHub offers no
conditional body update), and it is the ONLY coalescing side effect, so a
partial failure can never strand a half-recorded alias. Future regressions of
that SHORT-ID then resolve to the same issue via the primary lookup even when
a fresh verdict omits or changes `duplicate_of`, and retries take the plain
reused path without re-commenting. Lookup cost is bounded without ever
truncating past a genuine match: dup IDs are deduplicated, self-excluded, and
only then capped (5); the cheap body-marker scan runs across ALL
author-matched candidates; and alias comments are found via a dedicated
exact-phrase search (`"Also tracking Sentry <SHORT-ID>" in:comments`) that
essentially only genuine aliases can match — if that ever returns an
implausible candidate count (>10 projector-authored issues), the lookup fails
loud into the compensation path rather than risk skipping the real alias.

**Queue-stub side effects.** On a successful projection (created or reused) the
stub gets the `sentry:projected` label plus a comment linking the projected
issue, then the close step closes it as usual with the projected URL in the
closing comment. The `sentry:projected` label is bootstrapped by the ingest
label set (Stage A "Labels").

**Credential + isolation.** The cross-repo create/search use a dedicated
fine-grained PAT (`sentry-triage-projector`, Issues Read+Write on exactly the
three owning repos — no contents, no pull-requests), stored as the
`count`-gated Actions secret `SENTRY_PROJECTION_TOKEN` in the platform Terraform
stack (ADR 0030). It is exposed as **step-scoped** env on the projection step
ONLY — never job-level — so it reaches neither the triage agent (whose allowlist
and permissions are untouched) nor any other step. The local stub label/comment
use the ambient `github.token` (issues:write on this repo); the PAT is never
used for a local call. While the secret is absent on `main` the step is a
graceful no-op (`::notice::`), and the close step records the skip in the
stub's closing comment (visible, not silent). The token is additionally
**ref-gated**: on any non-`main` ref (branch `workflow_dispatch` would run
that branch's modified workflow/script code) the env expression resolves to
empty — a local-repo verdict still resolves and closes normally, but an
actionable EXTERNAL verdict is loudly re-queued (needs-triage restored,
verdict + projected labels shed, job fails) so a non-main dispatch can never
consume a stub that was never projected; the next `main`-ref run retries it.
Durable GitHub-Environment protection for this dispatch surface is tracked in
[#1289](https://github.com/mento-protocol/monitoring-monorepo/issues/1289).
Cross-repo fix **PRs** remain a later phase (ADR 0036 Stage C Phase 3,
[#1279](https://github.com/mento-protocol/monitoring-monorepo/issues/1279)) —
this step is Issues-write only.

**Failure handling.** On any projection failure the step compensates exactly
like the close step — restore `sentry:needs-triage`, shed the verdict label and
any partially-applied `sentry:projected`, and fail the job loudly so the
main-failure notifier fires and the next scheduled run retries. Nothing
strands.

## Operator runbook (Phase-1 activation)

Phase 1 provisions two read-limited credentials and one kill-switch variable
entirely through the platform Terraform stack (`terraform/`, ADR 0030
IaC-before-CLI): `github_actions_secret.sentry_triage_token`,
`github_actions_secret.claude_code_oauth_token`, and
`github_actions_variable.sentry_triage_enabled`. The two secret mirrors are
`count`-gated on their tfvar being non-empty, so the Terraform code can merge
and apply before the tokens exist. The pipeline stays inert until both tokens
are set **and** `SENTRY_TRIAGE_ENABLED` is `"true"`.

All token values live only in the platform stack's gitignored, operator-held
`terraform/terraform.tfvars` (the same file that supplies `lifi_api_key` and the
other `count`-gated platform secrets) — never committed, never set through
`gh secret set` or the GitHub UI.

1. **Mint the read-only Sentry token.** In Sentry (org `mento-labs`), create an
   internal integration named `sentry-triage-reader` with READ-ONLY scopes:
   _Issue & Event: Read_, _Project: Read_, _Organization: Read_. Add no write
   scopes — Phase 2 mints a separate write-scoped token only if and when
   auto-archive is approved (ADR 0036 trust boundary). Copy the generated token.
2. **Mint the Claude OAuth token — this rotates a shared live secret.**
   `CLAUDE_CODE_OAUTH_TOKEN` already exists as a live repo secret consumed by
   both `.github/workflows/claude.yml` jobs (the on-demand Claude assistant and
   the auto-review job), and GitHub cannot read secret values back, so the
   Terraform adoption necessarily writes a new value over the live one. Locally,
   on the Max plan, run `claude setup-token` to mint a fresh one-year,
   inference-only OAuth token. The first apply (step 4) overwrites the live
   secret with this fresh token — a rotation, not an outage: `claude.yml` and
   the triage workflows then share the new value. Do not put a placeholder or
   stale token here; a bad value breaks the existing Claude PR automation on its
   next run.
3. **Set both values in the platform tfvars.** In your local, gitignored
   `terraform/terraform.tfvars`, set `sentry_triage_token` and
   `claude_code_oauth_token` (see `terraform/terraform.tfvars.example` for the
   keys and placeholder comments). This is the exact same value source the
   `count`-gated integration-probe secrets already use. Once
   `claude_code_oauth_token` has been applied, never empty it again: the count
   gate would plan a destroy of the shared live secret, which the resource's
   `prevent_destroy` lifecycle guard rejects at plan time (deliberately loud —
   rotate by replacing the value, not by clearing it).
4. **Plan and apply the platform stack (human-approved local apply).** Run
   `pnpm infra:plan` and confirm the two new `github_actions_secret` resources
   appear (they are absent while the tfvars are empty); the
   `CLAUDE_CODE_OAUTH_TOKEN` "create" is an upsert that overwrites the existing
   live secret (see step 2). After human sign-off,
   run `pnpm tf apply platform` from a clean `main` checkout. The platform stack
   is manual-plan / manual-apply (`terraform.stacks.json` →
   `apply: "manual"`, `applyPolicy: "human-review-required"`); it is **not** a
   CI `production-infra` apply like the alerts/aegis/governance-watchdog stacks.
   The apply mirrors the two values into the repo Actions secrets
   `SENTRY_TRIAGE_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`. `SENTRY_TRIAGE_ENABLED`
   is provisioned by the same apply in its default `"false"` (off) position.
   After the apply, sanity-check the rotation by triggering any PR's Claude
   auto-review (or an on-demand mention) and confirming `claude.yml` still
   authenticates.
5. **Flip the kill switch to activate.** Once both Phase-1 workflow PRs
   (`sentry-triage-ingest`, `sentry-triage-agent`) are merged and the two tokens
   are applied, set `sentry_triage_enabled = "true"` in `terraform.tfvars` and
   re-apply the platform stack (still IaC, not the GitHub UI). The scheduled
   workflows activate on their next run.

To pause the pipeline at any time, set `sentry_triage_enabled = "false"` and
re-apply; the secrets can stay in place.

After flipping the switch, watch the next scheduled runs (ingest 05:30/13:30
UTC, agent 06:15/14:15 UTC) or trigger `workflow_dispatch` manually from the
`main` ref. Only the ingest workflow guards against dispatch from other refs
(`github.ref == 'refs/heads/main'` job guard); the agent workflow's
branch-dispatch hardening is tracked in
[#1289](https://github.com/mento-protocol/monitoring-monorepo/issues/1289)
(GitHub-Environment protection). Confirm the run-record comment lands on
tracker issue
[#1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282).

### Activating verdict projection (ADR 0038)

Projection is a separate, later activation from the read-only pipeline above:
the projection step is a graceful `::notice::` no-op until its PAT exists, so
the pipeline runs fine without it. When the team is ready to file owning-repo
issues automatically:

1. **Mint the `sentry-triage-projector` fine-grained PAT.** In GitHub (a bot or
   service account with access to the three owning repos, or an owner), create a
   **fine-grained** personal access token named `sentry-triage-projector`:
   - **Resource owner:** `mento-protocol`.
   - **Repository access → Only select repositories:** EXACTLY
     `frontend-monorepo`, `mento-analytics-api`, `minipay-dapp` — no others.
   - **Repository permissions → Issues: Read and write.** Set NOTHING else — no
     Contents, no Pull requests, no metadata beyond the mandatory read. This is
     the whole trust boundary; do not widen it (cross-repo fix PRs are Phase 3,
     [#1279](https://github.com/mento-protocol/monitoring-monorepo/issues/1279),
     and mint their own credential if/when approved).
   - Give it a bounded expiry and copy the generated token.
2. **Set it in the platform tfvars.** In your local, gitignored
   `terraform/terraform.tfvars`, set `sentry_projection_token` (see
   `terraform/terraform.tfvars.example` for the key and placeholder). Same value
   source as the other `count`-gated platform secrets — never `gh secret set`,
   never the GitHub UI.
3. **Plan and apply the platform stack (human-approved local apply).** Run
   `pnpm infra:plan` and confirm the new `github_actions_secret.sentry_projection_token`
   resource appears (absent while the tfvar is empty). After human sign-off, run
   `pnpm tf apply platform` from a clean `main` checkout. The apply mirrors the
   value into the repo Actions secret `SENTRY_PROJECTION_TOKEN`. Unlike
   `claude_code_oauth_token`, this secret is brand-new with no external consumer,
   so it carries no `prevent_destroy` — emptying the tfvar later cleanly removes
   it (projection reverts to the no-op).
4. **Verify.** On the next `code-fix`/`config-fix` verdict for an external
   owning repo, confirm an owning-repo issue is filed, the queue stub carries
   `sentry:projected` + a link comment, and the stub closes with the projected
   URL in its closing comment. To rotate, replace the tfvar value and re-apply —
   **with a PAT minted by the SAME account**: projected-issue reuse is
   author-keyed to the PAT's own login, so switching to a different account
   orphans existing projections' idempotency matching (re-projections would file
   duplicates instead of reusing).

**Backfill after an outage or at first activation:** the ingest's default
firstSeen window is 8 days, so Sentry issues first seen during a longer inert
or broken period fall outside the next scheduled scan. Run one manual
`workflow_dispatch` of `Sentry Triage Ingest` from `main` with the
`lookback_days` input widened (integer up to 90, e.g. `30`), or run
`pnpm sentry:ingest --lookback-days 30` locally with a `SENTRY_TRIAGE_TOKEN`.
Idempotency makes a too-wide window harmless — existing queue issues are
skipped.

**Backfill (queue hygiene closing, one-off):** the deterministic close step
(#1338) only closes queue issues going forward, from the run it merges in. It
does not retroactively close activation-era queue issues that already carry a
non-`needs-human` verdict label. Run this once after the #1338 PR merges (not
before — closing before the deterministic step exists would leave those
issues without the fixed closing comment's guarantee that a future regression
reopens them the same way). It is idempotent: `--state open` means a rerun is
a no-op for issues the first run already closed.

```bash
REPO="mento-protocol/monitoring-monorepo"

close_verdicted() {
  local label="$1" verdict="$2"
  gh issue list --repo "$REPO" --label sentry-triage --label "$label" --state open --json number --jq '.[].number' |
    while read -r n; do
      gh issue close "$n" --repo "$REPO" --reason completed \
        --comment "Triage complete: ${verdict}. Ledger entry closed; reopens automatically on Sentry regression."
    done
}

close_verdicted sentry:verdict-code-fix code-fix
close_verdicted sentry:verdict-config-fix config-fix
close_verdicted sentry:verdict-upstream upstream-transient
```

## Verification

```bash
pnpm sentry:ingest --dry-run   # needs a local SENTRY_TRIAGE_TOKEN; prints mutations without applying them
pnpm sentry:ingest:test        # node --test scripts/sentry-triage-ingest.test.mjs
pnpm sentry:digest:test        # node --test scripts/sentry-triage-digest.test.mjs (offline)
pnpm sentry:project:test       # node --test scripts/sentry-triage-project.test.mjs (offline)
# Print the Slack digest payload for a batch without posting (needs gh auth):
SENTRY_TRIAGE_ISSUES='[123,456]' pnpm sentry:digest --channel '#engineering'
# Project a single verdicted stub (needs gh auth + SENTRY_PROJECTION_TOKEN for a
# real cross-repo write; prints the JSON result). Absent token -> graceful no-op:
SENTRY_PROJECTION_TOKEN=… pnpm sentry:project --issue 123
```
