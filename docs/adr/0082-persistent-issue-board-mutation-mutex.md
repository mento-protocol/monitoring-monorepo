---
title: Persistent Issue-Board Mutation Mutex
status: active
owner: eng
canonical: true
last_verified: 2026-08-29
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0082: Persistent Issue-Board Mutation Mutex

## Status

Accepted.

## Context

The issue-board helper changes issue labels and GitHub Project fields through
separate APIs. Claim, review, release, sync, and backfill can target the same
issue. Project field reads and writes do not provide a compare-and-swap
operation. A read-write-read Claim ID reservation therefore cannot serialize
two delayed helpers. Two claims can both pass their reads. A claim and release
can also interleave and leave `agent-active` without durable ownership.

GitHub's REST update-reference endpoint does not provide an exact expected-SHA
condition. A non-fast-forward check alone makes the design depend on commit
topology. A create-delete mutex is also unsafe. A deleted fixed ref can be
recreated between a release read and delete. Ref node identity derives from the
ref name, so it does not fence that replacement.

GitHub's GraphQL `updateRefs` mutation provides the required compare-and-swap.
It applies all listed updates atomically. Each `RefUpdate.beforeOid` can require
one exact current object ID. The all-zero object ID requires the ref to be
absent.

## Decision

Each canonical repository and issue pair has one fixed custom ref:

```text
refs/mento-issue-board-locks/v1/<sha256-of-canonical-repository-and-issue>
```

The helper initializes the ref once. It retains the ref permanently. The ref
targets a commit chain that alternates `UNLOCK` and `LOCK`. Each state commit is
a direct child of the prior state and keeps its parent's tree. Its JSON commit
message records the version, state, canonical scope, operation type and ID,
selected Project owner and number, Agent, Claim ID, Claimed At, and current and
prior Branch and PR ownership.
These fields provide recovery evidence. They do not grant mutation authority.
Each lifecycle helper still proves the current Project ownership and external
state before it writes.

Initialization creates an `UNLOCK` commit, then calls `updateRefs` with the
all-zero `beforeOid`. An acquire reads the current `UNLOCK`, creates a direct
`LOCK` child, and calls `updateRefs` with the current ref SHA as `beforeOid`.
Two callers that read the same `UNLOCK` create sibling commits. Only one exact
compare-and-swap can succeed. Release creates an `UNLOCK` child of the owned
`LOCK` and uses the owned lock SHA as `beforeOid`. Every update sets
`force=false`. The helper never deletes or force-updates the ref.
A losing initializer accepts a reconciled valid peer `UNLOCK` and acquires from
that commit. It rejects a peer `LOCK` or invalid state.

The implementation depends on GitHub's documented `updateRefs` contract. The
mutation is atomic. `beforeOid` is an exact precondition. The all-zero object ID
asserts absence. `RefUpdate.name` accepts a fully qualified `GitRefname`. See
[Update refs](https://docs.github.com/en/graphql/reference/git#updaterefs),
[RefUpdate](https://docs.github.com/en/graphql/reference/git#refupdate),
and
[Create a reference](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#create-a-reference).
The helper reads the retained ref through
[List matching references](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#list-matching-references)
and its commit through GraphQL `Repository.object`. GraphQL
`Repository.ref(qualifiedName:)` returns null for refs outside `refs/heads` and
`refs/tags`, so it cannot observe the lock namespace (issue 2226).
The REST create contract corroborates custom namespaces because it accepts a
name that starts with `refs` and has at least two slashes. State commits use
[Create a commit](https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28#create-a-commit).
The active credential needs Project write access and repository Contents write
access.

Claim, review, release, sync, and backfill use this same per-issue mutex. Claim
ID, Agent, Branch, Claimed At, and PR are mutex-tool-owned fields. Every
repo-owned write to these fields routes through a mutex-protected lifecycle or
backfill call path.

After a successful acquire, the lock module privately mints one frozen opaque
owner-write capability. A dry-run mints the same logical capability without a
server ref. A module-private `WeakMap` binds the capability to the canonical
repository, issue, Project owner, Project number, operation, allowed owner
fields, and a trusted GraphQL target proof. The proof resolves the repository
and issue from the canonical repository and issue number. It resolves the
Project from the canonical owner and Project number. It binds the exact Project
node ID, repository node ID, issue Project item ID, and the IDs and types of
Claim ID, Agent, Branch, Claimed At, and PR. Before capability minting and each
fresh-claim target refresh, the proven repository node ID must equal the
repository node ID in the mutex lease. The helper rejects missing or duplicate
nodes, multiple matching items, pagination, repository replacement, and field
type drift. Caller Project and item data are consistency assertions only. The
Project node ID stays out of the persisted lock payload. The lock callback
receives the lease and the capability. The module does not export the mint,
seal, or revoke operations.
Production target proof always uses the canonical GitHub GraphQL transport. A
dedicated raw-transport factory exists only for the offline suite. A
module-private `WeakMap` registers the exact factory result. Copies and proxies
do not inherit its transport. The compiler proof permits only the factory
declaration and references in `scripts/pr/agent-issue-board.test.mjs`. It also
rejects namespace imports, dynamic imports, CommonJS namespace imports,
wildcard re-exports, and namespace re-exports outside that test. This covers
named imports, namespace access, destructuring access, alias sources,
re-exports, and call references. Its sole call site remains that test.
For dynamic imports and CommonJS `require`, the proof reduces const bindings,
concatenation, and static template substitutions. It resolves the result from
the importing file. For ESM, it uses WHATWG URL resolution. This covers query
and fragment suffixes, valid percent-encoded path bytes, mixed path separators,
and `new URL(relative, import.meta.url)` with a static `href` or `pathname`
projection. CommonJS paths keep filesystem path semantics and do not receive
ESM URL decoding. ESM requires an exact resolved file. CommonJS applies only
Node's `.js`, `.json`, and `.node` file and directory-index probes. It also
resolves a static, contained `package.json` `main` target with those same
bounded probes. The proof rejects every statically proven path to the lock
module. Hard-coded absolute paths and `file:` URLs, package import aliases,
loader aliases and `call` or `apply` helpers, alternate loader APIs, URL string
coercion, mutable state, runtime branches, function results, and external code
remain outside this static proof.

A fresh claim can acquire the lock before its Project item exists. Its initial
proof must show no matching item. The first owner write refreshes the same
canonical proof inside the tracked owner-write promise after Project membership
creation. Concurrent first writes share that refresh. The helper pins the one
proven item only when the repository, issue, Project, and owner-field schema did
not change. A dry-run reads the same canonical target and owner-field proof. If
that proof has no Project item, a claim dry-run accepts only the fixed
prospective item identity. Its guarded GraphQL calls cannot mutate GitHub.

`executeIssueOwnerMutation` is the only exported owner-write executor. The
Project field helpers use it for each raw owner mutation. It requires the exact
active capability object. Each binding states the semantic owner-field name
from the operation's intent. The executor resolves that name in the trusted
proof. It then requires the caller field ID to equal the proven ID before it
checks the proven type and operation allowlist. Stale same-type caller maps
therefore cannot redirect Agent, Branch, Claim ID, or PR values. The executor
also checks the full scope, operation, and proven Project and item IDs before it
invokes GraphQL. It does not derive authority from the caller's Project
field-name map. It registers the mutation promise before invocation and removes
it only after settlement. A forged, copied, proxied, swapped, sealed, or revoked
capability fails before GraphQL.

The lock seals the capability as soon as the callback settles. It then rejects
new writes, inspects and drains pending writes while the ref remains at `LOCK`,
and revokes the capability. The executor returns a tracked thenable. `await`,
`Promise.all`, `then`, `catch`, and `finally` create tracked continuations. A
write or continuation that is still pending at callback settlement is a
programming error.

An append-only callback-scoped ledger also records every settled root and
continuation rejection. Native Promise assimilation can route a rejection into
an outer Promise that the helper cannot track. It cannot remove the original
ledger entry. Before unlock, every reference-valued ledger entry must be
reachable by `Object.is` identity from the callback rejection through own data
`cause` properties or `AggregateError.errors`. The traversal rejects missing
evidence and protects against cycles. An ignored Promise container, swallowed
catch, late observer, or unrelated callback rejection therefore retains
`LOCK`. A directly awaited reference-valued failure or awaited `Promise.all`
failure can use the verified recovery path when the callback rethrows evidence
that contains the exact failure. A separate failure flag preserves `undefined`,
`null`, `false`, `0`, and empty-string callback rejections.

Each owner-write root has a unique internal lineage. Tracked continuations
inherit that lineage. Repeated propagation of one reference-valued rejection
within one lineage therefore remains recoverable through `then`, `catch`, or
`finally`. If two root lineages reject with `Object.is`-equal values, the helper
cannot prove which root reached the callback rejection. It treats every matching
occurrence as unpropagated and retains `LOCK`.

Primitive rejection values do not carry occurrence identity. The helper cannot
distinguish an awaited primitive owner failure from an unrelated callback
rejection with the same value. It therefore treats every primitive owner
failure as unpropagated and retains `LOCK`, including `undefined`, `null`,
`false`, `0`, and the empty string. Falsy callback rejections remain exact when
no owner write rejected.

Either a pending write or incomplete rejection evidence returns typed no-retry
recovery evidence and retains `LOCK`, even if the callback called
`markSafeToUnlock()`. The capability is revoked before every unlock attempt, so
an unlock failure cannot leave write authority active.

Claim, recovery, compensation, review, release, and backfill pass the capability
through every owner-field write. Sync receives a capability with an empty field
allowlist. It does not pass the capability to Project membership writes.
Project membership writes therefore remain outside this owner-field capability.
Project Status remains read-only. Grooming receives a capability with an empty
field allowlist and writes no Project field.

A repository-wide text inventory scans every tracked and nonignored untracked
file for each complete protected operation name. Each occurrence must be in the
exact allowlist. Executor occurrences must match AST tokens that the guarded-call
proof approved. This ADR permits one exact line for each operation. The proof
also pins the expected executor and ADR occurrence counts. The confinement test
constructs its canary names from split literals, so it needs no path exemption.
Shell scripts, package commands, standalone GraphQL documents, generated files,
vendored files, comments, and prose remain in scope even when no JavaScript or
TypeScript module imports them.

The inventory reads a symlink's stored link payload as bytes. It rejects invalid
UTF-8 and any byte-changing decode before it resolves or scans the target. It
accepts the symlink only when its repository-relative target stays inside the
repository and names another inventoried regular file directly. The target then
remains in the raw inventory and, when applicable, the compiler runtime
inventory. The proof rejects absolute, escaping, dangling, noninventoried,
directory, gitlink, and chained-symlink targets before it reads an executable
entrypoint.
It reads the NUL-delimited Git path inventory as bytes and rejects invalid
UTF-8 before any filesystem lookup. A lossy path can therefore never appear to
be a deleted file and escape either proof lane.

A compiler-backed inventory also scans every tracked and nonignored JavaScript
and TypeScript module. Generated, `dist`, vendored, test, spec, fixture, mock,
and coverage modules stay in scope. This includes a test-like module invoked by
a workflow or package command even when the protected operation uses a source
escape and no static import reaches the module. Static imports, re-exports,
literal dynamic imports, and literal `require` calls remain compiler edges. The
proof also scans each composite-action and workflow `run` value as executable
text.

The TypeScript checker resolves string literals, static templates and
substitutions, `const` bindings, parentheses, assertions, concatenation, named
imports, named re-exports, and wildcard re-exports. The GraphQL parser follows
nested selections, inline fragments, and named fragment spreads. It rejects an
owner mutation when its document has a missing, duplicate, cyclic, or
unreachable fragment structure. A lexical executable-text backstop rejects a
complete owner-mutation field name that the static resolver did not attribute
to an approved call. The compiler lane does not parse comments, Markdown, or
other prose as executable code. The repository-wide text lane still scans them.

Both `updateProjectV2ItemFieldValue` and
`clearProjectV2ItemFieldValue` must remain in
`scripts/pr/issue-board-projects.mjs`. Each operation must execute in its exact
field helper through `executeIssueOwnerMutation`. The call must pass the active
capability, `ownerMutationBinding(...)`, the static GraphQL document, and the
GraphQL transport. The executor parses the document, requires one exact
protected mutation field and exact variables, injects the proven Project,
item, and field IDs, and owns the `{ dryRun, mutates: true }` transport flags.
Nonvacuity checks require both operations and their executable text to remain
present.

The required `production-infra-contract` CI job runs `pnpm issue:board:test`
for every pull request, including after another step fails. It skips the proof
only when the job is cancelled. The local quality gate also routes changes to
the issue board helper file set to this suite. This CI step keeps the
repository-wide proof active when a new owner mutation appears outside that
file set.

The compiler proof cannot reduce a GraphQL document that depends on mutable
state, runtime-only branches, function results, or other dynamic data. The
repository-wide text inventory still rejects a complete protected field name.
The runtime executor closes the internal dynamic-builder gap: it rejects any
document that does not match the exact protected clear or typed update contract
before GraphQL runs. Ignored files, external packages, runtime-downloaded code,
and mutations made without this helper stay outside the inventory and executor.

External issue-label, blocker, owner-field, and PR mutations do not acquire the
ref. They are outside the helper's concurrency guarantee.

The helper still performs pre-mutation and post-mutation reads. It compensates a
failed transaction to a proven non-ready state when possible. These checks do
not make GitHub's separate APIs one atomic transaction. Project Status is
human-owned. No issue-board helper writes it. This boundary keeps a human
`Blocked` decision durable because a helper cannot overwrite it.

Project owner and number do not participate in the ref key because queue labels
belong to the repository issue. Two explicitly confirmed calls that target
different Projects must still serialize their label writes. Each state payload
records and validates the selected Project target before the helper acquires the
repository-issue lock.

Lifecycle mutations use the canonical repository and Project by default. They
reject ambient non-canonical `AGENT_ISSUE_REPO`, `AGENT_WORKBOARD_OWNER`, and
`AGENT_WORKBOARD_PROJECT_NUMBER` targets unless matching explicit flags confirm
them. Explicit flags can still select another target on GitHub.com. The helper
rejects a non-canonical `GH_HOST` and any host-qualified `GH_REPO`. Its transport
sets `GH_HOST=github.com` and removes `GH_REPO` before every gh call. An explicit
target flag cannot authorize another GitHub host.

The Project must provide `Agent`, `Branch`, `Claim ID`, and `PR` text fields and
a `Claimed At` date field. A normal claim generates and prints a
`claim-<UUID>` owner token. A caller can instead supply `--claim-id` with one
explicit issue. A manual non-sweep claim can omit `--branch`; the helper reads
the checked-out branch before it reads the Project or acquires the mutex and
stops before mutation if the checkout is detached or has no branch.
Agent and Branch metadata use the same bounded single-line contract in the CLI,
comment producer, and trusted-comment parser: Agent is 1-120 characters, Branch
is 1-256 characters, and neither value can contain leading or trailing
whitespace or control characters.
A claim adds a missing Project item, changes `agent-ready` to `agent-active`,
writes and verifies the complete ownership snapshot, and posts the claim
comment. Success and partial errors include the Claim ID.

`--sweep-eligible` requires one explicit issue, Claim ID, `--branch` value, and
`--body-sha256`; an ambient `AGENT_BRANCH` does not satisfy the branch
requirement. The digest binds the exact body snapshot that the orchestrator
classified for external dependencies. The helper checks that digest while it
holds the issue mutex. It also checks that the issue is open and `agent-ready`,
has exactly `risk:low` and one `pkg:*` label, has no native blocker, and has a
present non-`Blocked` Project Status. It repeats the body and ID-bound Status
checks at the points described below.

The explicit review branch rebind runs under the same mutex. It records the old
and new Branch and PR values in the lock payload. It preserves the Claim ID,
Agent, and Claimed At fields. It proves the selected same-repository open PR and
the absence of an open PR on the old Branch around the Project and label writes.
General release requires the matching Claim ID and refuses an `in-pr` issue or
a claimed Branch with an open PR. The explicit `--closed-unmerged-pr` path
proves the stored PR is closed and unmerged in the canonical repository and
that the stored Branch has no open replacement. It can restore `agent-ready` or
move the issue to `needs-grooming`.
The explicit merged-PR continuation also runs under the mutex. It proves the
exact stored repository, PR, Branch, and Claim ID on an open `in-pr` issue. It
requires that PR to be merged and its Branch to have no open replacement. It
then clears the owner and moves the issue only to `needs-grooming`.

Normal review reuses the stored Branch and requires the open same-repository PR
head to match it. Review requires the stored Claim ID, Agent, and Branch before
it acquires the mutex or changes labels or Project fields. It never substitutes
the command actor for a missing stored Agent. The explicit rebind replaces
Branch and PR only with the proven PR binding. A selected PR can still close,
change, or be replaced on the old Branch after the final proof because PR and
board APIs do not share one transaction. Release never falls back to an ambient
or local branch. It repeats the stored-branch PR proof before and after each
write and after its final label and ownership reads. A PR found before the final
proof causes exact compensation. A PR can still open after that proof.

A fresh claim accepts only a single ownership snapshot in which Claim ID,
Agent, Branch, Claimed At, and PR are all empty. A same-token claim retry does
not rebind ownership. Every non-empty Agent, Branch, Claimed At, and PR value
must match the retried claim. The helper validates the complete snapshot before
each reservation, including ready-state retries and partial-claim compensation.
It preserves the stored Claimed At date when the retry crosses a UTC date
boundary. It resolves that date before it creates the `LOCK` payload. A fresh
claim uses the current UTC timestamp. The helper writes only ownership fields
that its latest snapshot reports as missing. A Branch change requires the
explicit review rebind and its old-branch PR proof. A dry-run with no Project
item uses a prospective item identity. It plans the add and field writes without
reading a node that does not exist.

When comments are enabled, fresh claims and same-token recovery read the
complete issue comment history after they verify ownership. They accept only a
trusted, parseable claim comment whose Agent, Claim ID, Branch, and Claimed At
date match the durable ownership. They post the canonical claim comment when no
match exists. After a comment write, both paths re-list the complete comment
history and require the written comment to appear as a trusted, parseable,
matching claim before they report success. A comment read, write, or post-write
confirmation failure prevents claim or recovery success. A date-only retry
renders midnight UTC because the Project field does not retain a time. Dry-run
and `--no-comment` paths do not read or write comments.

An owner-target or capability proof failure during a fresh-claim target refresh
stops before partial-claim cleanup. The helper does not change issue labels or
owner fields. It retains `LOCK` for operator recovery. Review and release also
skip compensation for a capability proof failure. Backfill already rethrows
that failure without cleanup. Sync has no owner-field capability write. A
refresh transport failure becomes the same typed capability error and retains
its original cause.

Before each one-field Project ownership write, the helper re-reads Claim ID,
Agent, Branch, Claimed At, and PR in one snapshot. It requires an exact match
with the expected ownership at that point. It then advances the expected
snapshot by the field that it wrote. Review writes only Branch and PR. It does
not rewrite Claim ID, Agent, or Claimed At. Release and compensation use the
same fence. A conflicting value that remains visible in the next snapshot stops
the helper before a later field write. These fences remain required.

Project V2 does not provide a conditional field update. A direct external
writer can change the same field between the helper's final snapshot read and
its field update. The helper can then overwrite that value. A later read sees
the helper's expected value and cannot distinguish the overwritten external
write. An external writer can also rename or delete a proven field ID after the
target proof and before the update. GitHub can reject the stale ID, but it does
not provide a conditional schema or value update that closes the interval.
Pre-write and post-write fences can detect other observed drift. They cannot
close these provider gaps. Stop all helpers for the issue and prove that they
cannot resume before a manual owner-field repair. Direct and out-of-band
owner-field writes remain outside the guarantee.

An ambiguous ref update is reconciled against exact SHAs. The expected child
means success. The exact parent permits a bounded internal retry. After the last
retry, an exact parent observation still cannot prove that a delayed final
update did not apply or will not apply. A failed reconciliation read has the
same uncertainty. The helper returns `ISSUE_MUTATION_LOCK_STALE` with the lease.
An ambiguous acquire reports the candidate `LOCK` SHA and payload. An ambiguous
release reports the retained candidate `UNLOCK` SHA and payload and its exact
parent `LOCK`. It does not state that the ref remains at `LOCK`. Any other SHA
or an absent retained ref is an ownership conflict. The candidate can already
be live, so the caller must not retry the lifecycle command or create another
unlock. The helper does not use a TTL and does not steal a lock.

The helper creates the next state commit before it attempts the ref
compare-and-swap. A losing contender or a failed operation can therefore leave
an unreachable raw commit. The helper does not delete these objects. It treats
the fixed custom ref, its reachable state chain, and orphaned raw commits as
audit artifacts. GitHub can eventually garbage-collect an unreachable object,
so the ref chain is the durable audit record.

The helper advances an errored operation to `UNLOCK` only when no board mutation
started or when recovery verifies a stable exact non-ready state. Release
restores its previous endpoint only from its unsafe ready-state write. It
preserves a stable exact non-ready state that only an external writer could have
created. It also preserves a proven complete grooming endpoint. A grooming
label with previous or mixed ownership is ambiguous and keeps the `LOCK`.
Review preserves a proven complete review endpoint and a stable external
grooming state only when all five ownership fields are empty. A grooming label
with previous, partial, or mixed ownership is ambiguous and leaves the `LOCK`
in place for manual recovery. Any other ambiguous board mutation or failed
compensation also leaves the `LOCK` in place. The error reports the ref, lock
SHA, and payload.

Backfill is limited to ownership recovery after an eligible MCP claim. It
requires one open issue with exactly one of `agent-active` or `in-pr`, a valid
trusted claim comment, and the exact Project field types above. It does not
write `PR`. It reads and compares Claim ID, Agent, Branch, Claimed At, and PR
before each write and during final verification. A comment can omit Branch; the
helper then excludes Branch from its fill and conflict plan but keeps it in the
five-field drift snapshot. The operator starts with `--dry-run`. Backfill writes
Claim ID, Agent, Branch, and Claimed At only when its latest snapshot reports
them as empty. It rejects a mismatch that the snapshot shows and preserves
Status. It does not roll back a direct external write because that could erase
external state. It reads at most 100 comment pages or 10,000 comments and fails
closed on incomplete history.

Grooming routing writes take the same mutex. `issue:groom` writes `pkg:*`,
`risk:*`, and `kind:*` labels on one explicit issue. It refuses a queue-state
label and every other label class. It re-reads the issue's labels inside the
serialized section and refuses the write when the resulting set would satisfy
the backlog-sweep label predicate: `agent-ready`, exactly one `risk:*` equal to
`risk:low`, and exactly one `pkg:*`. The mutex serializes helpers, not people,
so the helper re-reads the labels after the write. When a label landed in
between and the issue is now sweep-eligible, the helper asks whether its own
write caused that. When removing exactly the labels it added would clear the
predicate, it removes them and exits nonzero. When the predicate holds without
them the write was not the cause: the helper keeps the labels and exits with a
distinct code, because undoing a correct label would leave the issue eligible
anyway and report the opposite. A removal that fails, or that leaves the issue
eligible, retains `LOCK` and names the labels an operator must remove by hand.
Every path before the write releases the mutex, so a failed read cannot strand a
`LOCK` that only ref surgery clears.

An operator recovers a stale lock only after proving that the original helper
cannot resume. The operator terminates its session or process, or revokes its
credential when that is the only reliable stop. The operator then inspects the
current ref first, then the issue labels, Project ownership fields, PR state,
and lock payload. An ordinary nonzero claim can be retried once with the same
Claim ID and Branch only when it did not report an ambiguous or stale mutex
outcome. Do not retry an `ISSUE_MUTATION_LOCK_STALE` result until this read-first
recovery proves the board and ref state. Automated candidate selection stops
when that code appears anywhere in the direct cause chain. It does not traverse
`AggregateError.errors`, because those members can retain the original claim
race beside an unresolved mutex-release failure. If an ambiguous release left the exact
parent `LOCK` and the board is safe, compare-and-swap it to the recorded
candidate `UNLOCK`. If the candidate `UNLOCK` is already current, do not write
another one. Reconcile any other SHA from the observed state. For a stale lock
without a candidate unlock, create an `UNLOCK` commit whose parent is the exact
stale `LOCK` and call `updateRefs` with that lock SHA as `beforeOid`. The operator
must not delete or force-update the ref. The ref compare-and-swap prevents the
old holder's later unlock. It cannot fence a delayed label, Project, or PR API
write because those writes do not carry the lock SHA.

## Workflow side effects

The ref does not use `refs/heads/` or `refs/tags/`. GitHub documents Actions
`push` filters for branches and tags. GitHub documents repository rulesets as
controls for selected branches and tags. The repository audit on 2026-08-28
found one active ruleset for `refs/heads/main`. It found only workflow `push`
triggers limited to `main` or `config-v*` tags. Mutex updates therefore do not
match a current ruleset or workflow trigger. A read-only live GraphQL query also
accepted the custom qualified name and returned no ref. The audit did not
create a ref.

The custom refs remain visible through the Git data API. Each completed helper
operation adds a `LOCK` and `UNLOCK` commit. Initialization adds one commit.
Losing compare-and-swap attempts can add orphaned raw commits. Repository object
count therefore grows with issue-board use.

Sync performs a live read-only preflight for each listed issue. It resolves
membership by the selected Project ID. It skips the mutex only when the issue is
open, has one exact queue label, and already belongs to that Project. A missing
open item is added under the mutex. The add must return the selected item ID.
Sync does not inspect or change Project Status. Every possible item add or label
cleanup acquires the mutex and re-reads the issue under that lock. A closed issue
cleanup verifies that the issue remains closed and that all queue labels are
absent. A concurrent reopen restores the exact queue label observed before
cleanup when possible. An ambiguous restore uses `needs-grooming` and preserves
any concurrent conflict.
A per-issue failure does not stop later issues. Sync lists the successful and
failed issue numbers and exits nonzero after it processes the list.

A sweep claim binds the selected Project item and Status field by their GraphQL
IDs. It reads the exact Status before the ownership reservation. It confirms the
same value after the reservation, label change, ownership-field write, settle
interval, and final verification. It applies the same before-and-after checks
to same-token recovery and partial-claim compensation. A missing value,
`Blocked`, or any changed option fails the claim. The helper never writes Status.
An observed blocker or drift cannot produce a successful claim. The helper
keeps any partial issue state outside `agent-ready`.
The claim also verifies `--body-sha256` after it acquires the mutex, after the
ownership reservation, after the label and ownership transitions, after the
settle interval, and at final verification. A changed body fails the claim. If
the transition started, the normal recovery path keeps the partial claim out of
`agent-ready`. Same-token recovery performs the same initial and final body
checks.
Before partial-claim recovery changes `agent-ready` to `agent-active`, it also
rechecks the low-risk label, package label, native blocker, and selected Project
Status requirements. An ineligible owned partial claim moves to
`needs-grooming`.

The issue reader gets native blocker relationships and exact Project item IDs
and Status values through one `gh api graphql` snapshot. It does not pass the
`blockedBy` JSON field to `gh issue view`, because that field requires GitHub
CLI 2.94.0. The GraphQL response keeps the same `totalCount` and `nodes` blocker
contract. Sweep eligibility matches the selected Project and Status field by
ID. Both Project-item readers require an explicit complete first page before
they use any item node. A truncated page, missing pagination state, title-only
Project snapshot, missing Status, or duplicate selected Project items fails
closed.

Project fields, ownership, Status, backfill values, issue comments, and PR
closing issue inference also fail closed on incomplete GraphQL connections.
Every page must contain a nodes array and a boolean `hasNextPage`. A one-page
reader requires `hasNextPage: false`. A paginated reader applies the same check
to every page.

The Project API has no Status compare-and-swap. The human-owned boundary removes
the overwrite race from the helper contract. A direct Status write before a
sweep observation is checked. A direct write between observations causes a
mismatch or `Blocked` failure. A write after the final observation remains
visible and linearizes after the completed claim because no helper Status write
can erase it. The mutex does not serialize the human writer and does not claim
to do so.

GitHub does not provide a conditional issue-body read that can share one
transaction with label or Project writes. A direct body edit does not acquire
the custom-ref mutex. The expected digest closes the long interval between the
orchestrator's semantic read and the helper's locked read. Repeated checks can
detect an edit during the helper transition and keep partial state outside the
ready queue. An edit after the final body check remains visible and linearizes
after the claim because the helper never writes the body. The helper does not
claim atomic compare-and-swap for body text.

## Compatibility evidence

Issue #2071 was claimed on Branch `worktree-shoggoth`. Its stage-one PR #2079
used head `feat/rank-backlog-skill`. That PR merged at
2026-08-27T13:02:47Z while the multi-stage issue stayed open. The owner moved
the issue to `needs-grooming` 49 seconds later and claimed stage two. This
settled history requires the explicit review branch rebind and merged-PR
continuation paths.

## Alternatives considered

- **Project Claim ID read-write-read.** Rejected because concurrent writers can
  both pass their reads.
- **Create and delete one fixed ref.** Rejected because a delete can remove a
  replacement created after the releaser's read.
- **Ref TTL or automatic lock stealing.** Rejected because a delayed owner can
  resume after a steal and mutate without a valid fence.
- **Force-updating the ref.** Rejected because it removes sibling-update
  exclusion and stale-owner fencing.
- **Use `refs/heads/` or `refs/tags/`.** Rejected because branch and tag refs can
  enter repository rulesets, workflow triggers, branch lists, and tag lists.
- **One repository-wide mutex.** Rejected because independent issues do not
  need to block each other.
- **Automatic Project Status projection.** Rejected because the Project API has
  no conditional Status update. A helper could erase a concurrent human
  `Blocked` decision between its final read and write.

## Consequences

- Helper mutations for one issue run in one server-enforced order.
- All repo-owned writes to Claim ID, Agent, Branch, Claimed At, and PR use the
  per-issue mutex.
- A stale `LOCK` stops later helper mutations until an operator proves and
  records recovery.
- The repository retains one custom ref per used issue and a small state commit
  chain.
- Direct GitHub mutations remain outside the mutex. A direct external same-field
  owner write can be overwritten in the unconditional Project update gap. Stop
  helpers before manual owner-field repair.
- Sweep body digests detect observed drift. They do not serialize direct GitHub
  body edits or provide a body compare-and-swap.
- Project Status remains human-owned and is never overwritten by a lifecycle
  helper.
