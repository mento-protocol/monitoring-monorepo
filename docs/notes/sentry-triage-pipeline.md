---
title: Sentry Triage Pipeline
status: active
owner: eng
canonical: true
last_verified: 2026-07-15
---

# Sentry Triage Pipeline

Operational reference for the Sentry issue triage/autofix pipeline decided in
[ADR 0036](adr/0036-sentry-triage-pipeline.md). This note is intentionally
sectioned by pipeline stage: each stage's issue lands its own section here so
later stages (triage-agent verdicts, phased mutations, the push leg) extend
this file instead of rewriting it. Only Phase 1 (deterministic ingest) exists
today.

## Queue contract

Stage A (`scripts/sentry-triage-ingest.mjs`, `.github/workflows/sentry-triage-ingest.yml`)
turns every new or regressed Sentry issue across the `mento-labs` org into
exactly one GitHub queue issue in this repo. The contract below is normative —
Stage B (the read-only triage agent) and later phases build against it. Do not
change it without updating the ingest script and this doc together.

### Source

- Sentry org `mento-labs` (SaaS, region `https://us.sentry.io`), 6 projects
  across 4 repos: `analytics-mento-org`, `analytics-api`, `app-mento-org`,
  `governance-mento-org`, `minipay-dapp`, `reserve-mento-org`. Every project's
  issues funnel into this repo's queue via one org-wide endpoint — fix PRs in
  the owning repo are a later phase, not part of Stage A.
- `GET https://us.sentry.io/api/0/organizations/mento-labs/issues/`, paginated
  via `Link` response headers.
  - New issues: `query=is:unresolved firstSeen:-8d`
  - Regressed issues: `query=is:unresolved is:regressed`
- `Authorization: Bearer $SENTRY_TRIAGE_TOKEN` (read-only token; Stage A never
  writes to Sentry).

### Title

```text
[sentry] <SHORT-ID>: <Sentry issue title, truncated to 90 chars>
```

Example: `[sentry] GOVERNANCE-MENTO-ORG-51: CombinedGraphQLErrors: An error occurred! …`

`<SHORT-ID>` is the Sentry issue's own `shortId` (e.g.
`GOVERNANCE-MENTO-ORG-51`). The title is the sole idempotency key — see below.

### Idempotency

Before creating an issue, search existing queue issues (**all states**) for
`[sentry] <SHORT-ID>:` at the start of the title:

- **Open match** → skip.
- **Closed match, Sentry issue is regressed** → reopen it, comment
  `Regressed in Sentry (last seen <ts>)`, and re-add `sentry:needs-triage`.
- **Closed match, not regressed** → skip (stays closed).
- **No match** → create.

At ~31 new issue groups/week org-wide, the ingest script does this as one
bulk `label:sentry-triage` search per run (not one search per issue) — same
matching semantics, cheaper on API calls.

### Labels

Every queue issue carries `sentry-triage` (the durable queue-namespace
marker, kept for the issue's lifetime) plus `sentry:needs-triage`.
`sentry:candidate-noise` is added when the raw Sentry title matches a noise
heuristic: `^Blocked '` (CSP reports), `TimeoutError`, `Failed to fetch`,
`Failed to load chunk`, `AbortError`.

Queue issues never get the dev-backlog labels (`agent-ready`,
`needs-grooming`, etc.) — this is a disjoint label namespace so the two agent
queues can't cross-claim each other's work.

The ingest script idempotently bootstraps every pipeline label on each run
(`gh label create --force`), including the verdict labels Stage B will use
before Stage B exists: `sentry-triage`, `sentry:needs-triage`,
`sentry:candidate-noise`, `sentry:verdict-code-fix`,
`sentry:verdict-config-fix`, `sentry:verdict-upstream`,
`sentry:verdict-needs-human`.

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
culprit: "handler in routes.ts"
permalink: "https://mento-labs.sentry.io/issues/6197137101/"
```

## Sentry Issue

`<truncated, neutralized title>`

[View in Sentry](<permalink>)
````

Sentry event payloads (titles, culprits) are untrusted, attacker-reachable
text. The ingest script never executes or evals anything derived from them;
every embedded string is truncated and neutralized (control characters and
newlines collapsed, every backtick replaced with a look-alike character so an
attacker-controlled title/culprit can never close the ```yaml fence early or
break out of the inline-code span in the human-readable section). The
permalink is only rendered as a clickable link when it parses as an
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
"the run silently stopped mattering."

## Operator runbook (activation)

Stage A ships inert. To turn it on (tracked in #1276, not part of this
issue):

1. Terraform-provision a read-only Sentry auth token as
   `secrets.SENTRY_TRIAGE_TOKEN` (never `gh secret set` by hand — IaC only,
   per the repo secrets rule).
2. Flip the repo Actions variable `SENTRY_TRIAGE_ENABLED` to `true`.
3. Watch the next scheduled run (05:30 and 13:30 UTC) or trigger
   `workflow_dispatch` manually; confirm the run-record comment lands on
   tracker issue #1282.

## Verification

```bash
pnpm sentry:ingest --dry-run   # needs a local SENTRY_TRIAGE_TOKEN; prints mutations without applying them
pnpm sentry:ingest:test        # node --test scripts/sentry-triage-ingest.test.mjs
```
