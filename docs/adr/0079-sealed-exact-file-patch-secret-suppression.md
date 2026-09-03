---
title: Autoreview permits only sealed exact-file-patch secret suppression
status: archived
owner: eng
canonical: false
last_verified: 2026-09-03
superseded_by: ADR-0086
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0079 — Autoreview permits only sealed exact-file-patch secret suppression

**Status:** Superseded by
[ADR 0086](0086-autoreview-removal-thin-two-model-review.md) (Sep 2026).
Historical decision retained. ADR 0086 deletes both the scanner this policy
constrained and the sealed record it authorized, so the issue #2114 exception is
retired with no successor.
**Scope:** ci/process

## Context

Issue
[#2114](https://github.com/mento-protocol/monitoring-monorepo/issues/2114)
tracks a false positive in the dashboard Hasura fixture. Restoring two cases to
their natural schema order makes the secret scanner report a
`literal credential expression` on one removed case label. The line contains no
credential. Reordering the cases only to avoid the scanner leaves the fixture in
an unnatural order.

[ADR 0068](0068-sentry-fixture-authoring-policy.md) rejects value and line
registries. Those registries can clear a different patch after a value moves or
a line number drifts. A general source-provenance matcher also adds a large
parser and support-span policy to the scanner's most sensitive boundary.

## Decision

Autoreview can mask one removed line only when a sealed record matches one
complete Git file patch byte for byte.

The runtime stores records in
`scripts/agent-autoreview-secret-suppressions.json`. Each record contains a
human reason, the scanner's exact expected first finding, one zero-based removed
anchor index in `patchLines`, its derived old line number, and every line of the
complete expected file patch. The first record covers the fixture reorder from
issue #2114.

The control has these rules:

- Git emits each scanned patch with `--full-index --unified=3 --no-color
--no-ext-diff --no-textconv`, explicit `a/` and `b/` prefixes, and no commit
  prose. Commit metadata remains separate review evidence and uses the closed
  scanner path.
- A record must describe one unchanged path, one full hexadecimal old blob ID
  that contains 40 or 64 characters, one full new blob ID of the same width,
  one unchanged ordinary mode, and one count-valid ordinary hunk. Rename, copy,
  added-file, deleted-file, binary, submodule, and combined forms are ineligible.
- The matcher splits only a pure Git patch capture into complete `diff --git`
  file sections. It requires exact line-array equality. It never searches for a
  substring.
- One section can match only one record. The full capture session can consume
  only one record occurrence. The configured anchor must be one unique removed
  hunk line. Its old line number comes from the validated hunk counts.
- The loader scans the stored patch without this exception and requires the
  exact expected first finding. The matcher changes only the anchor line to a
  bare removal marker in a copy. It then scans the matched section, the pure
  patch capture, and the complete assembled bundle without this exception. Any
  sibling finding still blocks the review.
- Supplemental prompts, evidence files, refs, branch names, commit prose,
  status output, stats, and untracked-file serialization use the closed
  `secretLikeReason` default. Header-shaped arbitrary text never enters the
  exact-patch matcher.
- The changed-path classifier permits only the exact repository path
  `scripts/agent-autoreview-secret-suppressions.json`. The general sensitive
  path classifier still rejects this filename. No other path receives this
  changed-path exception. Every other path follows the general sensitive-path
  classifier. The policy diff still passes through the suppression-free content
  scan.
- The JSON loader resolves the file next to the materialized core. It accepts no
  reviewed-checkout path and no override. The stable bounded regular-file read
  rejects symlinks, hard links, path replacement, and read-time mutation.
- The JSON uses one canonical representation with exactly one final newline.
  The loader rejects unknown or reordered keys, duplicate records or patches,
  noncanonical JSON bytes, excessive records or patch lines, overlong lines,
  and strings that contain anything outside printable ASCII. This excludes
  embedded CR, LF, NUL, ANSI escapes, bidi controls, and other non-printing
  characters.

The JSON is executable policy. It belongs to every frozen, materialized, and
attested autoreview runtime closure. The full closure now has eleven files: the
shell wrapper and ten non-shell files.

## Consequences

Any byte change in the expected file patch, including its context, blob ID,
path, hunk coordinates, line kind, or final newline, disables the exception.
The change then follows the existing fail-closed scanner path.

Adding or changing a record is a runtime-control change. It needs an independent
review from a trusted compatible checkout. The quality-gate signature, routing
table, Turbo inputs, CI path filter, runtime materializers, and runtime trust
docs all pin the JSON path.

The record is intentionally brittle. A later legitimate edit near the fixture
must remove or replace the stale record through the same runtime-control review.
This ADR does not authorize value, line, regular-expression, support-span, or
source-provenance exceptions.

## Alternatives considered

- **Keep the fixture in scanner-driven order.** Rejected because the source
  order would continue to encode an unrelated scanner limitation.
- **Change the scanner heuristic.** Rejected because a broader accept shape
  would affect every bundle and could admit a real credential.
- **Use an anchor plus selected support lines.** Rejected because partial patch
  matching adds path, hunk, expression-boundary, and copied-line ambiguity. The
  complete exact file patch is smaller and easier to audit.
- **Read an allowlist from the reviewed checkout or an environment override.**
  Rejected because the change under review could then widen its own gate.

## Evidence

- `scripts/agent-autoreview-core.test.mjs` covers exact matching, drift,
  malformed forms, duplicates, bounds, canonicality, and sibling findings.
- `scripts/agent-autoreview.test.sh` covers both patch capture paths, separated
  commit metadata, and runtime-closure drift.
- `scripts/agent-autoreview.sh` owns the frozen and attested runtime lists.
- `scripts/agent-autoreview-secret-suppressions.json` contains the exact issue
  #2114 record.
