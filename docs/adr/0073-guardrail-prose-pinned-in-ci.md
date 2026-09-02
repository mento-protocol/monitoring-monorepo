---
title: Normative guardrail sentences are pinned in CI, and scripts are not
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0073 — normative guardrail sentences are pinned in CI, and scripts are not

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

The strongest rules this repository has are prose. "Never merge without the
user's explicit approval for that specific merge", "Secrets are IaC-owned",
"Terraform apply requires explicit human approval", "Forensic drafts stay
local" — each exists as a sentence in `AGENTS.md`, in the `CLAUDE.md` symlink
beside it, and in `docs/notes/pr-operating-card.md`. Agents read those files as
ground truth at the start of every session; [ADR 0005](0005-context-as-product.md)
makes that the point of the context layer.

Nothing enforced their continued existence. Those same files are edited
constantly — by the documentation garden ([ADR 0040](0040-bounded-documentation-garden-queue.md)),
by context-budget trimming, by agents fixing a neighbouring paragraph. A rule
could disappear inside an unrelated cleanup and no check would red. The loss
would be silent in the worst way: the next session simply would not know the
rule existed, and the first evidence would be an agent merging a PR nobody
approved.

The failure mode has a name in this tree. [ADR 0064](0064-scripts-module-directories.md)
records enumerated path pins whose miss is silent — "the job stops running while
the required `ci` sentinel stays green" — and [ADR 0062](0062-sentry-suites-self-run-gate.md)
records a required check proving from output that it actually ran rather than
merely existing. This is the same class applied to sentences instead of jobs.

## Decision

**A pin list holds each normative sentence, and CI fails when one goes missing.**
`scripts/repo-health/guardrail-prose.json` maps a repository-relative path to
the snippets that path must carry;
`scripts/repo-health/check-guardrail-prose.mjs` reads each file and reports any
snippet it can no longer find. Removing a rule is then a two-file change — the
prose and the pin — in one PR, which a reviewer sees. It stays possible, and
stops being invisible.

**Matching is whitespace-normalized substring, and pins are one clause long.**
Every whitespace run collapses to a single space on both sides, so a Prettier
rewrap or a sentence moving across a line break never fails the check; only the
words changing does. Pins are deliberately short. A pinned paragraph would turn
every reword into a CI failure and train people to edit the pin without reading
it, which is the opposite of what this protects.

**The loader fails closed on every unusable shape.** A pin file that is
missing, unparsable, not an object, empty, holding an empty snippet array, or
repeating a top-level key is a hard failure, never "no pins to check". The
duplicate-key case is the subtle one: `JSON.parse` keeps only the last of two
identical keys and reports nothing, so a repeated path would silently discard
the earlier block's pins with no deletion anywhere in the diff. A reviver cannot
see it either — the reviver walks the already-collapsed result. The check reads
the raw text for duplicate keys instead.

**The job that runs it is unconditional.** `guardrail-prose` in
`.github/workflows/ci.yml` carries no `if:`, sits in the `ci` sentinel's
`needs`, and is deliberately absent from its `allowed-skips`. This follows
[ADR 0010](0010-required-checks-no-paths-filters.md): a skipped required check
counts as satisfied. The first implementation of this decision put the two
commands in the path-gated `scripts` job, which admits on `scripts/**` and is
allowed to skip — so a PR editing only `AGENTS.md` and dropping a pinned
sentence skipped the check entirely while `ci` stayed green. The Sentry suites
were moved out of that same job for the same reason. The suite pins its own
wiring: the job id, both `run:` strings, the sentinel's `needs`, and the absence
of an allowed-skip, each with a negative control that mutates the real workflow.

**The wiring assertion runs from two jobs, so neither is its own only witness.**
Read alone, the paragraph above is circular: the assertion that `guardrail-prose`
still exists lived only inside `guardrail-prose`, so the single edit deleting
that job and its sentinel entry deleted the assertion too and left `ci` green
over nothing. The suite therefore also runs as a step of the path-gated
`scripts` job. That job's `rootScripts` filter includes `.github/workflows/**`,
so any edit able to remove the unconditional job admits `scripts` and reds
there; and the suite asserts that second host as well, so dropping the extra
step reds in the unconditional job. Each is the other's witness. Deleting both
in one commit still passes — no check can outlive its own removal — but that
edit is visible in a single diff, which is the property being bought throughout
this record. The cost is one duplicate sub-second run on `scripts/**` diffs.

**Present is not the same as enforcing.** A `run:` line proves the command is
written down, not that its failure stops the job. A step-level `if:` makes the
step skip, and `continue-on-error` makes its failure advisory; either leaves the
required `ci` context green over a guardrail that no longer holds, and the
job-level `if:` above is only the coarsest version of the same move. The suite
therefore rejects step-level `if:` and `continue-on-error` on every guardrail
step in both hosts, and `continue-on-error` on the job itself, each with its own
negative control. Ten controls now mutate the real `ci.yml`, and each asserts
the mutation changed the file before asserting the check reds.

**`CLAUDE.md` carries its own pin block.** It is a symlink to `AGENTS.md` and
`readFileSync` follows it, so both blocks read the same bytes and the
duplication is free today. It is also the path the Claude runtime loads, and
nothing else asserts it stays a symlink. The block starts earning its keep the
moment that link becomes a divergent regular file or is dropped.

## Alternatives considered

**Pin script digests too, or instead.** The obvious generalization: hash the
gate, the autoreview wrapper and the helper scripts, and fail when a hash moves.
Rejected, and this is the deliberate scope limit of the decision. Those scripts
are legitimately agent-maintained and change in most weeks; a digest pin would
red on every intended edit, so the pin would be updated reflexively as part of
the commit and would stop carrying information within a month. The repository
already protects that surface where it matters and where the pin is not noise —
`agent-autoreview.sh` hashes its own blob against a frozen-HEAD snapshot before
an explicit-ref review, and `.gitattributes` plus `UPSTASH_MCP_LAUNCHER_SHA256`
byte-pin one reviewed artifact ([ADR 0065](0065-scripts-file-size-watchlist-scope.md)
records both). Prose is the surface where a pin is cheap, because normative
sentences are supposed to be stable: a rule that changes monthly is not a rule.

**Pin whole sections rather than clauses.** Stronger coverage — a rule gutted
from within its own paragraph would be caught. Rejected on the same reflex
argument: section-level pins fail on ordinary rewording, and a check that reds
on legitimate edits gets its expectations updated without being read.

**Rely on review and CODEOWNERS.** No new machinery. Rejected: bots sample
rather than enumerate, and a deletion inside a large documentation-garden diff
is exactly what a sampling reviewer misses. Human review of every AGENTS.md
edit is not the working model here.

**Run the check only in the local pre-push gate.** The gate already routes it
from both directions — an edit to the checker or the pin list, and an edit to
any protected prose file, `CLAUDE.md` included. Rejected as the only route: the
local gate is skippable by anything that does not run it, including a web
session or an edit landed through the GitHub UI, and the pins are worth exactly
what the weakest route enforces. M5 retired that local route. Required CI is
the binding route.

## Consequences

- Changing a normative rule now costs a same-PR edit to
  `scripts/repo-health/guardrail-prose.json`. That is the intended friction and
  the entire mechanism: the pin list becomes a reviewable registry of which
  sentences the repository considers load-bearing.
- **The check proves presence, not obedience.** It cannot tell whether an agent
  followed "never merge without explicit approval"; it only proves the sentence
  is still there to be read. It also cannot stop a determined removal — a PR
  that edits both files passes. Visibility is the property being bought, not
  prevention.
- Adding a new normative sentence does not pin it. Coverage grows only when
  someone adds the pin, so the list will trail the prose. The 90-day
  re-verification on this record is where that gap is reviewed.
- CI gains one job boot per PR: a checkout, a Node, and two sub-second commands
  with no `pnpm install`, since the checker and its suite import only `node:`
  builtins.
- Moving `AGENTS.md`, `CLAUDE.md`, or the operating card means editing the pin
  keys in the same PR. `scripts/AGENTS.md` records this pin class under the
  move-sweep inventory ADR 0064 requires.

## Evidence

- Checker and fail-closed loader:
  [`scripts/repo-health/check-guardrail-prose.mjs`](../../scripts/repo-health/check-guardrail-prose.mjs)
- The pinned sentences:
  [`scripts/repo-health/guardrail-prose.json`](../../scripts/repo-health/guardrail-prose.json)
- Behaviour, negative controls, and the CI-wiring assertion:
  [`scripts/repo-health/check-guardrail-prose.test.mjs`](../../scripts/repo-health/check-guardrail-prose.test.mjs)
- The unconditional job and the `ci` sentinel's needs/allowed-skips:
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
- Local gate routes from the protected prose files, not only from `scripts/`:
  `scripts/gate/routing-table/groups-head.mjs`,
  `arms-scripts.mjs`, `arms-agent-modules.mjs`
- Move-sweep pin inventory: [`scripts/AGENTS.md`](../../scripts/AGENTS.md)
- Issue: <https://github.com/mento-protocol/monitoring-monorepo/issues/2069>;
  PR: <https://github.com/mento-protocol/monitoring-monorepo/pull/2073>
