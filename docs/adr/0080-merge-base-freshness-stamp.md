---
title: The gate's freshness stamp binds the merge-base
status: active
owner: eng
canonical: true
last_verified: 2026-08-30
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0080 — The freshness stamp binds the merge-base, not the base tip

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

`scripts/agent-quality-gate.sh --run` writes a whole-run freshness stamp so a
later `--skip-if-fresh` run can exit without re-executing the mapped commands.
The pre-push hook in `.trunk/trunk.yaml` is the main consumer: it runs
`git fetch --quiet origin main` and then the gate with `--skip-if-fresh --base
origin/main`.

The stamp bound the base ref's **tip** OID. `origin/main` advances about ten
times a day — 148 commits over the 15 days to 2026-08-27 — and each advance
changed that field for every worktree on the machine at once. A warm stamp was
therefore invalidated by other people's merges, not by anything about the branch
it validated. Because the hook fetches immediately before it runs the gate, a
warm-up that merely overlapped an advance paid for the whole gate a second time.
The 2026-08 quality-gate audit that raised this recommendation put the overlap
at 37% or more of warm-ups.

The binding was also wider than what the gate actually validates. Changed-path
detection already uses the three-dot diff `git diff "$base_ref...$head_ref"`,
which is scoped to the merge-base. The tip is not an input to the validated
content; it was an input to the cache key over it.

Three commands in the plan genuinely do read the tip. `react-doctor:diff` bakes
the resolved base OID into its Turbo cache key, `check-adr-reminder.mjs`
receives `--base <ref>` and resolves that ref when it runs, and
`check-peg-registry-integrity.mjs` reads the previous peg policy out of the base
tip with `git show <ref>:<policy path>`. For the second, the plan text carries
only the ref _name_, so the command-plan hash is byte-identical on both sides of
a fetch: nothing else in the stamp would have noticed. The third named the base
nowhere at all — it defaulted to `origin/main` inside `inferredPolicyBaseRef()`
while the gate emitted a bare command — so the gate now passes it
`--base-ref`, carrying the resolved base OID, from the same facts the other two
read.

## Decision

The stamp's base field holds the merge-base of the base ref and the effective
head, labelled with which binding produced it (`merge-base:<oid>` or
`tip:<oid>`). Three guards bound the change.

1. **Failure is closed.** An unresolvable base, head, or merge-base — disjoint
   histories, a ref naming no commit, or a criss-cross where
   `git merge-base --all` reports several merge bases — falls back to the tip
   OID, the older and stricter binding. No failure path answers "fresh". The
   `--all` is load-bearing: plain `git merge-base` prints one OID even when
   several best merge bases exist, and which one it picks is unspecified, so
   asking without `--all` would bind an arbitrary pick instead of failing
   closed.
2. **A plan that can observe the base tip keeps tip binding.** The gate asks
   whether the command plan's text names the base ref or its resolved tip at
   all, rather than keeping a list of tip-reading commands. A future verb that
   passes the base down inherits tip binding without anyone remembering to
   extend a list, and a false positive costs only the stricter binding. The
   search matches the `printf %q` spelling of the base as well as its raw text,
   because that is what the plan actually carries: every verb interpolates the
   base through `shellQuote`, and git permits characters in a ref name that
   `%q` escapes, so `origin/qu'ote` reaches the plan as `origin/qu\'ote`.
3. **The binding kind is part of the field.** A tip-bound stamp and a
   merge-base-bound stamp cannot be read as each other on a branch whose base
   has not advanced, where the two OIDs coincide.

The coordinator's execution fingerprint keeps binding the base tip. It is the
identity for sharing one live execution between concurrent requests, not a
cache key over time, and this record does not widen it. The stamp reader
therefore also records the warm run's base tip and requires full fingerprint
equality only when both HEAD and that tip are unchanged — the same shape as the
pre-existing HEAD exception, whose argument it reuses: when the v4 stamp and the
coordinator freshness context both match, every fingerprint input except HEAD
and the base tip is already proven equal, and each of those two is compared
directly.

Nothing else in the stamp moves. Changed paths, the command plan, the gate
implementation hash, the validated content signature, and the package-risk
policy all bust the stamp exactly as before, and the two-hour TTL still applies.

## Alternatives considered

**Keep the tip binding.** Correct but wasteful, and wasteful in a way that
pushes agents toward `--no-verify`. Rejected.

**Bind the merge-base everywhere, including the coordinator fingerprint.** This
would also let concurrent requests with different base tips share one execution.
The fingerprint is an exact-execution identity and `check-adr-reminder.mjs`
resolves its base at execution time, so two requests differing only in tip can
produce different answers. Rejected as a real weakening for no measured gain.

**Enumerate the tip-reading commands.** A literal allowlist of
`react-doctor:diff` and `check-adr-reminder.mjs` is precise today and silently
wrong the first time a verb passes the base down without updating it. The
structural predicate fails toward the stricter binding instead. Rejected.

The predicate reads only what the plan text says, so it carries an obligation
the allowlist did not: a command that reads the base must be made to NAME the
base. Review of this change found `check-peg-registry-integrity.mjs` reading
`origin/main` through an internal default while the gate emitted a bare command,
which no textual predicate could have caught. The fix belongs at the emitter,
not in a second list: its verb now passes `--base-ref`, and `engine.test.mjs`
fails if any routing-table arm spells the check as a bare command again. The
predicate keeps its self-maintaining property for every command that states its
base, and one guard test holds the emitters to it.

The verb sends the resolved base **OID**, not the ref. `validateGitRef` in that
validator admits only `[A-Za-z0-9._/-]+`, so ref spellings the gate itself
accepts — `HEAD~1`, or a ref carrying a quote — would make every peg plan fail
before it validated anything. A hex OID always satisfies that allowlist, which
keeps the gate from mirroring a regex owned by another script, and it pins the
base the gate measured so a fetch landing mid-run cannot move the comparison.
The `__unresolved__:` sentinel falls back to the ref, and that path stays
fail-closed: an unresolvable ref throws `cannot resolve policy base ref`, and a
rejected spelling throws `invalid policy base ref`. The validator's
no-baseline return is reserved for a ref that resolves without carrying the
policy file yet, so neither failure can be mistaken for a skip.

An audit of every emitted command then found two that the emitter fix cannot
reach, because the ref they read is not the gate's base. `docs:navigation-eval
-- --validate` tests ancestry against `refs/remotes/origin/main` as the DEFAULT
branch, and the autoreview suite read protected-main checklist blobs at
`origin/main^{commit}`.
[ADR 0086](0086-autoreview-removal-thin-two-model-review.md) has since deleted
that suite, so the navigation eval is the only marker command left. Handing it
the gate's `--base` would change what it asserts — on a stacked PR the default
branch is still `main`. It is named in a short marker list inside the predicate,
the fallback this ADR otherwise rejects, and the reasoning holds because the
failure is asymmetric: a listed command only ever gets the stricter binding, so
a stale entry costs a re-run while a missing one costs a skipped check. The residual is that a rename makes a
marker stale silently; the `markerbound` stamps-freshness fixture is what
notices, since it asserts tip binding for a real navigation-eval plan.

A marker match binds the **default branch's own OID** as a second component,
`+default-branch:<oid>`. Binding the base tip alone was not enough, and the
stacked PR is the case that shows why: with `--base origin/<parent>` the base
tip and the merge-base both hold still while `origin/main` advances underneath,
which is the advance that changes these commands' answers. The two refs coincide
only when the base happens to be `origin/main`. Resolution failure keeps
`ref_oid`'s `__unresolved__:` sentinel, which differs from every OID, so a
default branch that is absent and later appears still busts the stamp — and the
navigation eval itself reports an unreachable default branch as an error, so a
run cannot be stamped green in that state anyway. Such a plan also keeps tip
binding, which nothing measured requires; it is strictly stricter, and the
marker's runtime behaviour was established from its source rather than by
running it, which is not a gap worth trading for a narrower binding on one rare
command.

## Consequences

A warm stamp now survives an advance of `origin/main` that leaves the
merge-base alone, which is the common case. It does not survive a rebase, which
moves the merge-base, nor any change to the validated content, the plan, or the
gate's own implementation. Plans containing `react-doctor:diff`, the ADR
reminder, or the peg registry check keep the old behaviour and gain nothing;
dashboard-wide, workflow-touching and peg-policy changes are therefore
unaffected.

Guidance to warm the stamp only after `git fetch origin main` is no longer
required for the stamp's sake, and
[`../notes/agent-quality-gate-mechanics.md`](../notes/agent-quality-gate-mechanics.md)
carries the current rule. [ADR 0076](0076-fair-quality-gate-coordinator.md)
describes the coordinator whose fingerprint this record deliberately leaves
alone.

`scripts/agent-quality-gate.test.sh` (family `stamps-freshness`) covers the
merge-base-preserving advance, the rebase, the tip-reading plan, and the
disjoint-history fallback, each with a same-fixture reuse control so a fixture
that could never reuse cannot pass them.
