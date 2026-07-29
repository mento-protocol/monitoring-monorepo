---
title: Forensic Report — Production Upload Procedure
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Production upload procedure

Deep procedure for Step 10 of [`SKILL.md`](../SKILL.md). Upload happens only on
`--upload` or an explicit user confirmation; the local draft is the default.

## Write guard

Keep `mcp__upstash__redis_database_run_redis_commands` out of repo-shared
auto-allow lists. **The MCP approval prompt is the production write guard for
this path.**

## Uploader identity

Derive the uploader's email at runtime, never from a hardcoded value. The skill
is committed and runs from any teammate's checkout; a hardcoded email would
mis-attribute every other person's reports and leak PII into git.

```bash
AUTHOR_EMAIL=$(git config --get user.email)
if [ -z "$AUTHOR_EMAIL" ]; then
  echo "git config user.email is unset — set it before uploading" >&2
  exit 1
fi
```

`git config user.email` is local and unauthenticated — a teammate with a stale
or impersonated config could persist wrong audit metadata. The dashboard's
editor route stamps `authorEmail` from the Google-Workspace-authenticated
session for that reason; this path bypasses the route to keep atomicity and so
loses the session-auth check. Mitigation: **always show the derived email and
ask the user to confirm it matches their workspace identity before sending the
EVAL.** If it's wrong, abort and tell them to fix `git config user.email` (or
upload via the editor UI). For a stricter audit trail, route the upload through
the editor instead.

## Validate inputs before building the payload

This path bypasses the API route, so it also bypasses the route's validators.
Apply the same checks the owner modules apply — read them, don't re-derive them:

- **Address** — must satisfy `isValidAddress` in
  `ui-dashboard/src/lib/validators.ts` (`/^0x[a-fA-F0-9]{40}$/`), then lowercase
  it for the hash key. A key that isn't an `0x` address (ENS, typo, truncation)
  is unreachable by the address book.
- **Body and title** — must survive `sanitizeReportInput` in
  `ui-dashboard/src/lib/address-reports-shared.ts`: body required and non-empty
  after trim, **≤ 50,000 characters** (`MAX_BODY_LENGTH`); title optional,
  trimmed, dropped if empty, **≤ 200 characters** (`MAX_TITLE_LENGTH`).

## Build the partial payload

The Lua script stamps `createdAt` / `updatedAt` / `version`; you supply `body`,
optional `title` (text after the `—` separator in the H1), `authorEmail`, and
`source`. The literal payload shape — including the runtime-specific `source`
value — is in `SKILL.md`, which is the file the mirror check normalizes.

## Derive the expected version

Immediately before uploading, HGET the current record again. Capture the
unwrapped HGET value; **abort on malformed JSON or a non-object instead of
treating it as an absent report.** Then:

- No stored record → `expectedVersion = ""`. That is **create-only**: the write
  fails if another writer creates the record first.
- Stored record → `expectedVersion` is the stored `version` as a string when it
  is a finite number greater than zero (floored); legacy, missing, null, or
  invalid versions normalize to `"1"`. This mirrors the `priorVersion`
  normalization inside the script — keep the two in sync.

## Write it via the owner implementation

Copy the current `UPSERT_SCRIPT` from `ui-dashboard/src/lib/address-reports.ts`
exactly; that module owns the matching server-side normalization,
expected-version check, and response envelope. Never use an older
last-writer-wins copy, and never split it into a read-modify-write sequence —
the optimistic-concurrency (CAS) semantics are the point.

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: DATABASE_ID,
  commands: [
    [
      "EVAL",
      UPSERT_SCRIPT,
      "1",
      "reports",
      addrLower,
      JSON.stringify(partial),
      new Date().toISOString(),
      expectedVersion, // "" for create-only; otherwise the fresh base version
    ],
  ],
});
```

Parse the returned `{ok, report}` envelope. If `ok !== true`, stop, show the
version conflict, re-read the editor's newer report, and ask before
reconciling. **Never auto-retry with a new base version.**

## Verify

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: DATABASE_ID,
  commands: [["HGET", "reports", addrLower]],
});
```

The address-book index endpoint reads from the same hash on every request, so
the 📄 indicator and the report editor pick up the new content on the next page
load — no SWR mutate hook needed from this side.
