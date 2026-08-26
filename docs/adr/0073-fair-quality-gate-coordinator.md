---
title: Fair local quality-gate coordination across worktrees
status: active
owner: eng
canonical: true
last_verified: 2026-08-25
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0073 — Fair local quality-gate coordination across worktrees

**Status:** Accepted (Aug 2026). In force on branches that contain this change.
**Scope:** ci/process

## Context

[ADR 0007](0007-agent-quality-gate-and-merge-oracle.md) established the local
agent quality gate. Several agents and pre-push hooks now run that gate from
linked worktrees on one machine.

Unrestricted overlap is unsafe. Issue
[#1802](https://github.com/mento-protocol/monitoring-monorepo/issues/1802)
recorded dashboard coverage and browser-policy failures under CPU contention.
The current browser fixture also binds fixed loopback port 3211, so independent
browser runs cannot overlap safely. The machine-wide `run.lock` stopped these
failure classes by allowing only one `--run` gate to execute mapped commands at
a time.

The full-run lock made unrelated work wait. Issue
[#1894](https://github.com/mento-protocol/monitoring-monorepo/issues/1894)
was found during four-agent parallel pushes after two callers reached the
1,800-second wait bound. That issue fixed a fail-open piped exit, but did not
remove the wait. Local duration records from 2026-08-21 show the cost. One run
recorded 1,710 seconds total and only one 14-second Trunk execution. Another
recorded 1,306 seconds total and about 64 seconds of command execution. Lock
wait dominated both runs.

Issue
[#2006](https://github.com/mento-protocol/monitoring-monorepo/issues/2006)
requires concurrent progress without restoring the failures from #1802. It
also requires fair admission, exact-result coalescing, bounded machine load,
mixed crash recovery, and a non-zero result for every run that neither
executes nor reuses verified work.

## Decision

### Use one transient coordinator

`scripts/gate/quality-gate-coordinator.mjs` is the machine-wide scheduler. It
runs on Node 24 and accepts local clients through a Unix domain socket under a
private scheduler root. A client that cannot reach a live coordinator uses an
atomic election to start one. Startup first binds the socket with a not-ready
handler. That handler rejects requests with `COORDINATOR_STARTING`. The new
coordinator then token-checks and adopts the legacy lock, writes its ready
metadata, and starts accepting requests. Failed adoption closes and removes the
socket without replacing the previous legacy owner. The coordinator normally
exits after the queue, workers, recovery drains, and client handoffs are empty
for the configured idle period. It is not a permanent service.

The server tracks every accepted socket, including sockets accepted by the
not-ready handler. Shutdown destroys those sockets before it waits for the
listener to close. A half-open startup client therefore cannot keep the legacy
lock after coordinator shutdown.

Detached startup has a 10-second bound. An ordinary RPC has a 5-second transport
bound. A wait RPC uses its requested wait bound plus a 1-second transport
margin. Startup appends diagnostics to `coordinator.log` and rotates one
`coordinator.log.1` when the current log exceeds 1 MiB.

The adapter checks the exact Unix socket path through the coordinator runtime
before it takes the lock. If that path exceeds the portable 100-byte bound, the
adapter reports the condition and uses the serialized legacy lock for that run.
It does not run mapped commands without exclusion.

The protocol, journal schema, and scheduling policy have explicit versions. A
client or coordinator rejects an unsupported version, malformed state, or
invalid resource name before it starts work. The Bash adapter rejects resource
names outside its policy allowlist. It never silently falls back to unrestricted
execution.

The effective policy also binds the hosting Node runtime identity and the
production coordinator source signature. The runtime identity covers the
resolved executable path, version, platform, architecture, and `NODE_OPTIONS`.
Only a SHA-256 digest of that identity enters the policy. This server identity
is distinct from the request-specific inputs in the execution fingerprint.
Those inputs bind the request's Node and pnpm toolchain and material command
environment.

The gate copies the two Bash adapter files into one private directory. It
verifies the copied hashes against stable source snapshots taken before and
after the copy. It then sources only those copies. The prepared policy binds
their exact hashes. After the gate acquires the legacy lock, it rechecks the
prepared policy before recovery or coordinator startup. The starting parent
and detached child each derive the current Node and source identity again. The
child repeats that check before root setup, stale-socket removal and binding,
durable state initialization, legacy adoption, startup maintenance, and ready
publication. A mismatch stops the next transition. A later startup failure
closes the bound socket and restores the previous legacy owner.
After startup, the production source attestor rechecks the loaded coordinator
runtime before every non-detach RPC mutation, wait registration, connection
binding, and response. A changed copied runtime stops the server before that
request can change durable state.

Ready-file existence is not a successful handshake. The parent validates the
published protocol, policy, capacity, namespace, child identity, generation,
and authority against a live coordinator `inspect` response before it returns.
If publication fails after an atomic rename, the child removes only canonical
metadata that names its exact policy, generation, and process identity. It
fsyncs each parent directory before it restores legacy ownership and closes the
socket.

The Bash adapter creates one random 32-byte capability for each request. It
passes that value only to the request client processes. The detached
coordinator child removes the value from its environment and refuses startup if
the value remains. The coordinator stores only the capability's SHA-256 digest
in the request record and journal. Status output omits that digest. Every
request-scoped status, wait, lease, result, acknowledgement, cancellation, and
idempotent registration call must present both the capability and the exact
owner PID/start identity. Stale-owner mutation is internal to the coordinator.
It uses a bound-client disconnect or a direct process-identity observation.
Each bound registration, including retained-result reuse, stays attached to a
separate lifecycle process. The parent atomically writes `clean` or `unclean`
to a private control file, waits for the lifecycle completion record, and then
waits for its cached child. It never signals a stored PID, which could identify
a different process after PID reuse. `TERM`, `HUP`, `INT`, parent death, and
transport loss destroy the connection and start stale-owner cleanup.

This capability prevents one cooperative local gate from changing another
gate's request after it copies public scheduler state. It is not a security
boundary against hostile code that already runs as the same operating-system
user. Such code can inspect or control peer processes. Drain recovery remains a
cooperative cross-client operation. It uses the run token and verified process
tags because a successor must drain work after the original client has died.

A journal commit failure or terminal-result persistence failure is terminal.
The coordinator marks itself stopping before another message can run, closes
existing and new clients, and abandons the legacy owner for stale recovery. It
does not release the lock from its mutated in-memory state. A successor loads
the last durable journal and any exact immutable result. A result waiter reads
a result only after the journal marks its request result-ready.

### Keep the legacy lock during the transition

The coordinator owns the existing machine-wide `run.lock` from successful
legacy adoption until all queued and running new-protocol work and recovery
drains finish. New clients join the coordinator instead of trying to take that
lock themselves. An older gate that does not know the coordinator sees the
legacy lock and waits. If an older gate owns the lock first, a new gate waits
for that owner before it starts a coordinator.

This compatibility rule prevents an old worktree from running beside scheduled
workers. New Bash publishers retain the padded legacy process-start wire value;
new readers normalize only at comparison boundaries. Release atomically moves
the current owner pathname to a recovery-visible record inside `run.lock`. It
then verifies the moved current-user inode and generation token against its
prior snapshot. A replacement that wins before the move is detected and is
restored or retained. Only the matching inode can enter a mode-0700 private
release directory. The Node coordinator also requires the exact record text. A
crash before validation leaves the moved record visible to the legacy recovery
scan. That scan applies the machine verdict and lock-root locality before it
uses a local PID. It retains another-machine evidence and unverified evidence
on a root that may be shared. It also stops on an unreadable or unsafe remnant,
or if a shared-root access rule prevents restoration while the canonical owner
is absent. Release then removes only an empty lock directory. Before `rmdir`, it
removes only known unpublished owner stages whose publishing PID is gone. A
successor owner or live stage keeps the directory non-empty and remains
untouched. A directory-removal failure restores the exact private owner through
a hard-link witness. The coordinator then closes its holder marker descriptor,
reports `release-failed`, and settles every close waiter. The next gate can
recover the restored owner. Final cleanup quarantines and deletes only the
bound private inode. A same-text replacement is retained and makes release fail
closed.

Node opens every mutable legacy owner or unpublished owner-stage path with
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. It uses `fstat` to require a current-UID
regular file before it reads the owner or changes a stage's mode. A symlink or
FIFO fails closed. The nonblocking open prevents a FIFO from waiting for a
writer before the type check.

Bash opens the original owner before release and retains that descriptor across
both owner moves. It parses the authority token through a duplicate of the open
descriptor. Linux exposes `/dev/fd/<n>` as a symlink, so the release parser
validates the descriptor target directly. It does not pass that pseudo-path to
the shared-path no-symlink guard.

A process crash after successful `rmdir` is different from a caught release
failure. It can leave the private owner and holder marker outside the authority
path. The operating system closes the marker descriptor, and no close waiter
receives a caught-error result. The next gate takes a new lock. The top-level
leftovers remain inert and do not block that gate.

The coordinator releases the legacy lock only after every admitted worker and
recovery drain is gone.

The coordinator checks its legacy owner and marker before each request,
response, and maintenance mutation. The owner check binds the path to its exact
inode and text. The marker check binds the path to the descriptor that the
coordinator opened with exclusive creation. It requires the exact inode,
current UID, and generation text. The scheduler checks authority again
immediately before each grant. Terminal result publication has the same guard.
Authority loss stops the coordinator and leaves the durable journal and legacy
record for recovery. A displaced coordinator cannot grant queued work, prune
records, clean up owners, or publish success. Rollback and release also remove
the marker through an exact-inode quarantine. Every coordinator marker cleanup,
including publication failure, adoption failure, rollback, and release, uses
this top-level lock-root directory:
`holder.reclaiming.quarantine.v1.<hostname-sha256>.<pid>.<nonce>`. Crash remnants
from those quarantines are inert and never enter Bash owner recovery. Cleanup
retains a replacement marker.

A Bash run or command holder marker contains raw `<token>\n` bytes. It is not an
owner record. Normal drain removes it only after the process census is empty.
`EXIT` cleanup attempts removal only after worker teardown and while no command
drain is active. Cleanup binds the current pathname at cleanup time: it requires
a current-UID, non-symlink regular file with the exact raw body, then creates a
hard-link witness for that inode. This rule does not claim that the inode is the
one created at run start. The private directory uses the disjoint name
`holder.reclaiming.quarantine.v1.<hostname-sha256>.<pid>.<nonce>`. If the shared
path names a different inode after the witness, cleanup returns status 2 and
retains the quarantine. If the move placed that different inode in the
quarantine, cleanup can restore it to the shared path with an exclusive hard
link only when it is a current-UID, non-symlink regular file with the exact
`<token>\n` body. The quarantine retains both private inodes after that
restoration. A moved entry with an unsafe type, UID, or body stays private. A
replacement that appeared after the move stays at the shared path. That cleanup
attempt never deletes its post-witness replacement. After a refusal, that
process does not retry cleanup for the token during a later drain or `EXIT`
teardown. `EXIT` cleanup still attempts legacy-lock release. It changes an
otherwise successful status to 2 when marker or lock release fails and preserves
an earlier non-zero status. A `SIGKILL` can leave a top-level holder quarantine;
no recovery scan consumes it, and it grants no authority.

On Linux, the process scan opens the shared marker with `O_NOFOLLOW`. It
requires a current-UID regular file with the exact `<token>\n` body. It holds
that descriptor while it scans signal-scope `/proc/<pid>/fd` entries by device
and inode. It probes signal permission, including `CAP_KILL`. It also compares
the sender real/effective UIDs with each target's real/saved-set UIDs so a
policy-confined or set-ID descendant stays in scope after an `EPERM` probe. It
reads each process start identity before and after UID and descriptor
enumeration. A changed identity makes that observation empty. A restricted
`hidepid` mount or another incomplete in-scope scan fails closed.

On hosts without usable procfs, the process scan never asks `lsof` to query the
mutable shared marker pathname. It creates a mode-0700 private directory named
`.holder-lsof-witness.v1.<hostname-sha256>.<pid>.<nonce>`, hard-links the current
marker into it, and validates that scan-time link as a current-UID, non-symlink
regular file with the exact raw `<token>\n` body. `lsof` reads only the
witnessed inode. Normal cleanup and invalid-snapshot cleanup remove only the
private witness state. A host with neither scanner fails closed while a marker
exists. A `SIGKILL` can leave the private hard link behind. No recovery scanner
consumes it, and it grants no authority.

The coordinator compatibility record leaves `start_utc=` blank so older Bash
readers that fetch fields in separate snapshots fall back to PID liveness. It
writes the exact start identity to `coordinator_start_utc=`. A new coordinator
reads that field from one record snapshot.

Adoption preserves the incoming owner record's group and other read bits so a
legacy waiter with shared-root access can observe the barrier. The replacement
record remains writable only by its owner. It stores the real coordinator
generation in the `coordinator_token` field. It stores `coordinator-owner-v1`
in the historical `token` field. That value is outside the historical run-token
grammar, so a historical gate waits and does not attempt a coordinator drain it
cannot understand. A current gate prefers the `coordinator_token` field. Before it
discards stale owner evidence, it requires the recorded `uid=`, when present,
and the file owner to match its current UID. A current gate can wait on another
user's live owner. It retains a stale foreign owner's record and generation
evidence, then exits with status 2. The owning user or an administrator must
recover that generation. A discard creates a hard-link witness in a fresh
mode-0700 quarantine beside the record. It reads the authority fields from one
open descriptor for that witness, requires the current UID, and rejects
duplicate authority fields. The Node coordinator also retains the exact text
for later equality checks. The discard establishes either a canonical hard
link or a published condemned-run obligation before it moves the shared
pathname beside the witness. It deletes only the private names after it
verifies that they still name the witnessed inode. A path replacement is
retained and stops the gate, even when it has the same text and authority token.

The legacy owner record stores the gate's cached `uname -n` value in `host=` and
its resolved machine identity in `machine=`. The owner-quarantine namespace
records the quarantine creator in names of the form
`owner.reclaiming.quarantine.v2.<machine-source>.<machine-sha256>.<hostname-sha256>.<created-epoch>.<pid>.<nonce>`.
The PID component is a positive decimal JavaScript safe integer from 1 through
9,007,199,254,740,991. Bash and Node reject larger values before a liveness
check.
This metadata identifies the process that created or claimed the quarantine.
It does not identify the owner record inside it. A waiter accepts historical
`owner.reclaiming.quarantine.v1.<hostname-sha256>.<pid>.<nonce>` names for
recovery, but the name alone does not decide which machine created the evidence.

The waiter applies the machine verdict and lock-root locality rules before it
uses a local PID. A same-machine creator is reclaimable when its PID is gone or
is a zombie. It never applies a local PID verdict to another-machine evidence or
to unverified evidence on a root that may be shared. It can reclaim unverified
evidence on a proved or declared per-machine root only after the
unverified-machine grace period and a dead or zombie PID. A v1 quarantine uses
its directory modification time for the conservative age check because its
name has no creation epoch.

Before a waiter recovers a reclaimable quarantine, it atomically renames the
whole directory over a verified empty mode-0700 placeholder that carries the
waiter's v2 creator metadata. This claim orders recovery against a creator's
orphaned file-move child and against other waiters. A waiter that loses the
source-name race restarts the quarantine scan and observes the winner's new
name before it examines ordinary remnants. A crash after the directory claim
leaves the same versioned evidence for the next waiter.

The Bash legacy path uses atomic pathname operations when it publishes initial
quarantine and condemned-run state. It does not fsync those initial files or
directories. The descriptor-bound directory-claim helper later fsyncs the
claimed quarantine and its parent. That partial fsync does not make the complete
Bash protocol power-loss durable. Its recovery guarantee covers process and
signal crashes while the mounted filesystem remains available. It does not
claim sudden-power-loss durability. The coordinator journal and other Node state
use the separate fsync order described below.

Adoption does not change permissions on an explicit shared legacy lock root.
The outer coordinator namespace includes the numeric UID. Its state directory
contains separate version-, policy-, and capacity-specific namespaces.
Sequential users of one shared root do not inherit another user's mode-0700
coordinator directory.

A gate cannot drain coordinator journal entries through the socket. If all
remaining state is drain-required work from dead clients, and no live client,
waiter, drain claim, or result handoff remains, the coordinator closes its
socket after the idle period without releasing `run.lock`. A current gate that
runs with the coordinator disabled can then reclaim a same-UID dead coordinator
owner. It records the coordinator generation as a legacy drain obligation and
drains every worker through the shared generation marker. Each worker retains
that marker after its mapped wrapper exits. A historical gate treats the
versioned compatibility token as unreclaimable and waits until a current gate
recovers or releases the owner. The same-PGID close-all-handle guarantee
requires a gate version with anchored group capture. A queued, granted, or
result-ready request prevents this recovery handoff.

### Serialize each worktree for the full request

The coordinator grants one full-run lease per real worktree root. The key is
the resolved `git rev-parse --show-toplevel` path, not the shared Git common
directory. The lease covers request admission, execution, terminal result
publication, and local result handoff.

This lease protects worktree-local mutable state: `.tmp` logs and stamps,
`node_modules`, generated files, Terraform data directories, coverage and
mutation reports, and dashboard build output. Different worktrees do not share
this lease. Terminal publication marks each attached request result-ready but
does not release its worktree admission. Each client reads and validates the
result, completes its local handoff, and explicitly acknowledges it. Only that
acknowledgement removes the client request and admits the next request for the
same worktree. Owner cleanup acknowledges a result-ready request whose client
died. If a bound leader dies before its drain completes, the journal records
that its later terminal result must be acknowledged automatically. Recovery
preserves this flag. Terminal completion then removes the dead request and
admits the next same-worktree request without relying on PID liveness.

### Schedule fairly under weighted capacity

`AGENT_QUALITY_GATE_CAPACITY` configures global capacity from 1 through 64. Its
safe default is 3. Each ordinary command uses one unit. The gate self-test uses
weight 2 when capacity is at least 2 and weight 1 at capacity 1. A request's
`--parallel` value is a local upper bound. It does not increase the available
global execution capacity.

Scheduling is fair at the request level. Each runnable request receives at
most one ordinary dispatch per turn, then moves behind the other runnable
requests. Arrival sequence and current resource blockers are observable. One
parallel pool can queue several leases, but it cannot consume every fair
dispatch turn while another request is runnable.

Parallel workers return their command status and lease ID to the gate parent.
Each lease persists a unique command drain identity before mapped work starts.
The parent captures and drains that identity and the registered worker process
group before it unregisters the worker or releases the lease. It then refills
the local pool. A failed drain or release keeps the lease ID, stops dispatch,
and enters request cancellation and drain recovery. A worker cannot hide an
unsettled command while the parent starts a replacement command.

A queued command with weight greater than 1 reserves enough capacity when it
becomes the oldest weighted lease at the head of its request. The reservation
also holds while that lease waits for a named resource. Younger light work
cannot consume the reserved capacity. An all-capacity command forms the
strongest such barrier. When the command reaches its fair turn, the coordinator
stops admitting new ordinary commands, lets current work drain, then grants the
command all capacity. Later short requests cannot keep either weighted class
waiting indefinitely.
An older ordinary lease that is blocked by a named resource does not block a
grantable weighted reservation. The scheduler first grants the oldest eligible
ordinary lease. If none is eligible, it evaluates the weighted reservation.

The following evidence-backed classes use all capacity:

- dashboard full or scoped coverage;
- dashboard browser tests and their fixture build;
- dashboard production build and size-limit work;

The three mutation baselines remain ordinary weight-1 commands. Their recorded
serial runtimes do not prove cross-run contention. The global capacity still
bounds their aggregate concurrency.

Browser work also claims the named `browser-fixture-3211` resource because the
fixture server binds fixed loopback port 3211. Playwright installation claims
the named `playwright-install` resource because every worktree mutates the
shared `~/.cache/ms-playwright` browser store. Each named resource has capacity

1.

Resource names and weights are part of the versioned policy. A new exclusive
class needs measured contention evidence and scheduler regression coverage.

The coordinator accounts only commands registered through a gate `--run`
request. Finish direct validation, dashboard servers, and browser suites on the
same machine before the gate starts. Do not start unregistered work until the
gate exits. Such work can mutate worktree state or consume resources outside the
scheduler's capacity and named-resource controls.

### Coalesce only exact final verdicts

Requests coalesce when their complete execution keys match. The key binds:

- repository identity, the base and HEAD OIDs, changed paths, validated file
  bytes and modes, and the normalized command plan;
- the gate, coordinator, and policy implementation signatures, including the
  `.trunk/trunk.yaml` content;
- OS and architecture, plus the resolved Node and pnpm executable paths and
  versions;
- the effective per-command timeout, effective `--lock-wait` scheduler budget,
  resolved local parallelism, and fail-fast policy;
- material, command-specific environment inputs, represented by safe digests
  rather than raw secret-bearing values.

The environment digest keeps PATH entry order and duplicates. It normalizes an
entry that resolves exactly to the current worktree's `node_modules/.bin`, a
`PNPM_SCRIPT_SRC_DIR` or `INIT_CWD` that resolves exactly to the current
worktree root, and `TMPDIR`, `TMP`, or `TEMP` when it resolves exactly to the
gate-owned `.tmp/agent-quality-gate` directory. Other values remain exact.
Selected values include standard proxy settings, GitHub base-event inputs,
parent-consumed quality-gate self-test controls, and nonsecret tool controls.
Different selected values prevent shared execution and retained-result reuse.
The mapped-command launcher removes child-only test and validator injections,
including `ESLINT_BASELINE_INPUT`, inherited `ESLINT_BASELINE_MAIN`, alert-rule
fixture paths, validator root overrides, focused child-test controls, and
ambient cloud-provider credentials that the autoreview tests can forward.
These values stay outside the shared key because no mapped descendant can read
them. An assignment inside a mapped command still applies after the launcher
removes the inherited value. CI package lint jobs do not use this launcher, so
their `ESLINT_BASELINE_MAIN` assignment remains active. Legacy lock-test
controls that the parent gate consumes stay in the outer key, but the launcher
removes them from mapped descendants. The nested gate marker
`AGENT_QUALITY_GATE_LOCK_HELD` remains available to the self-test. The launcher
also removes inherited Trunk launcher identity and quiet controls, plus
credential-bearing `CURL_FLAGS` and `WGET_FLAGS`. The mapped Trunk wrapper
supplies its own identity. The provisioning probe sets quiet mode inside its
sanitized child. Normal mapped commands inherit the gate-owned `CI=true`, which
makes the Trunk wrapper quiet. The gate removes inherited `GIT_*` controls
before its first Git probe and from mapped descendants.
Stable content digests for ignored `.env` and `.env.*` files in workspace roots
bind values that Envio, Next.js, and other tools load after registration.
Tracked `.env.*.example` files stay outside this manifest.
Turbo lint, build, and fixture-build keys declare the corresponding environment
and dotenv inputs that the gate can reach, so inner cache reuse preserves the
same boundary.
The digest binds selected external tool and configuration locations by their
literal values. It does not recursively hash the contents of system tool,
certificate, HOME, or XDG paths. Do not use a retained result after content at
one of those external paths changes without its path changing.
The gate removes caller-controlled Bash startup files, option sets,
compatibility controls, and exported function records before it starts an
internal Bash control shell or mapped command. It uses privileged Bash mode for
those shells. The filtered environment propagates to mapped descendants. This
boundary prevents caller startup controls from changing a shared result through
an internal control shell or mapped-command tree.
The local-bin token binds bounded manifests for the repository root and every
known mapped package root. Each manifest binds its root label, missing or
present state, entry names, modes, types, and wrapper bytes. For a symlink
entry, it also binds the link and the resolved regular file's mode and bytes.
All manifests share one entry and byte budget. A symlinked local-bin root,
unsupported entry, unstable snapshot, or exceeded size limit fails closed. A
link path replaces the physical worktree root only when the complete target
equals that root or starts with that root plus `/`. The complete path must equal
its lexical canonical form and contain no `.` or `..` traversal. Wrapper and
dereferenced target bytes remain exact unless they are valid UTF-8 pnpm shell
shims that start with `#!/bin/sh` and contain exactly one
`# cmd-shim-target=` sentinel. In a recognized shim, the manifest replaces only
canonical complete root or root-descendant paths in the sentinel and in
colon-delimited segments of exact assignments that start with two spaces
followed by `export NODE_PATH="..."`. It preserves all other bytes and line
endings. All other link paths, PATH entries, and selected environment values
also remain exact.

A frozen install does not replace the local-bin manifests with an expected
post-install token. pnpm can retain an unexpected executable in `.bin`, and
that executable remains on a package script's `PATH`. Registration, first
dispatch, and result publication therefore bind the current root and package
manifests. If dependency setup changes one of those manifests, terminal
reattestation cancels shared publication. A later run binds the resulting
post-install state.

The manifest reads at most one entry beyond its entry limit and stops before it
sorts names. Before it reads each regular wrapper or symlink target, it checks
the declared file size plus the name and link bytes against the per-file limit
and the remaining aggregate byte budget. This rule bounds rejection work while
the stable double snapshot still detects directory or file changes.

These normalization rules remove pnpm's checkout-path spelling from the key
while preserving local tool identity and the separately bound Node and pnpm
identities.

The coordinator attaches matching callers to one leader execution. It shares
the exact terminal result, including its status and payload. It does not share
worktree-local build or generation output or expose per-command statuses as the
coalesced result.

An active exact-key execution takes precedence over an older reusable success.
A matching caller joins that active singleflight. The coordinator considers a
retained success only when no matching execution is active. A plain manual
`--run` requests no retained-success reuse. `--skip-if-fresh` may reuse a
verified success that is no more than two hours old.

The worktree-local whole-run stamp can satisfy `--skip-if-fresh` before request
registration. Its compatibility key binds every complete-key input except the
HEAD OID. The stamp also records the exact HEAD and coordinator fingerprint.
An unchanged HEAD requires that exact fingerprint to match. A changed HEAD can
reuse the stamp only when the base, paths, plan, validated bytes and modes,
implementation, toolchain, timeout, local parallelism, fail-fast policy,
effective `--lock-wait` budget, runtime policy, OS, architecture, and material
environment still match. This narrow exception
keeps a gate run made before a commit valid after that commit records the same
validated bytes. Coordinator singleflight and retained-result reuse remain
bound to the complete key, including HEAD.

The leader revalidates the complete key immediately before the first command
and after the last command. A mismatch invalidates the execution. It cannot
publish success. A failed, cancelled, interrupted, or disconnected leader
never produces a success result for a waiter. Completed failures are delivered
to current waiters, but only a verified success can satisfy later freshness
reuse.

A leader can skip a Trunk arm only after a post-failure check classifies the
environment as blocked. The launcher probe reports `provisioning-unavailable`
when it cannot fetch the CLI. The fail-closed transcript classifier reports
`downloads-unavailable` when the CLI cannot fetch a plugin source, runtime, or
linter. The leader publishes either outcome as a qualified success with
`reusable: false` and the exact skip reason. Active followers receive the same
terminal result and matching warning. The coordinator does not index it for
retained reuse and removes an older success index for the same fingerprint. A
later `--skip-if-fresh` request must execute and retry Trunk. The scheduler
lease stays reserved until classification, any launcher probe, and all
identified descendants drain.

The leader gate owns the worker. A follower disconnect only detaches that
follower. A leader disconnect, cancellation, interrupt, or stale-owner verdict
starts the drain and publishes the same non-success result to every attached
follower. Recovery never transfers a leader's uncertain execution to a new
success-producing worker.

Blocking RPC helpers carry the request and coordinator process handles. They do
not retain the caller's output descriptors. A result wait is bound to the exact
follower request and owner identity. Owner cleanup removes that request and
ends its orphaned wait after a hard-killed follower. Normal cleanup atomically
writes a private cancellation file and waits for the helper's completion
record. It never signals a stored wait-process PID.

### Persist the recovery evidence before releasing resources

The adapter's private root is `qgc-v1-u<uid>`. It contains
`coordinator.json` and a version-, policy-, and capacity-specific state
namespace. That namespace
contains `journal.json`, one `requests/<requestId>.json` record per request, and
immutable terminal results under
`results/<fingerprintHash>/<executionId>.json`. The coordinator writes mutable
state through same-directory temporary files and atomic renames. It creates
each terminal result as an immutable file. The journal assigns monotonic
request sequence numbers and records each capacity or named-resource lease.
For a new result hash directory, the writer first fsyncs the parent directory.
It fsyncs the staging file, creates the final hard link, fsyncs the hash
directory, removes the staging link, and fsyncs the hash directory again. Only
then can it commit the journal transition. Startup validates retained results,
fsyncs each result directory and the `results/` parent, and only then writes a
recovery journal transition. This repair order also covers a valid final link
left by a process that stopped before its journal commit.
An existing result file is reusable only when every semantic field matches,
including the payload and ordered follower list. Reuse returns the persisted
record and its original completion time. Startup validates the full result
schema, protocol, policy, fingerprint, execution, leader, unique ordered
followers, status, bounded payload, and canonical UTC completion time before it
recovers or adopts legacy authority. A retained-success index must name the
same execution and completion time as its immutable result.
Result publication checks legacy authority before the immutable write,
immediately after that write, and before the journal commit. If authority is
lost after the final link appears, the coordinator atomically renames that link
to its writer-generated staging name and fsyncs the result directory. Startup
ignores that staged link and cannot recover it as a success.
Inactive request records are pruned. Terminal result records and verified
success indexes remain available for two hours, then expire. An expired result
remains while any active leader or follower still needs its local handoff.
The coordinator commits removal of an expired success index before it unlinks
the matching result. A failed commit leaves both records intact. A crash after
the commit can leave an unindexed valid result, which the next prune removes.

Maintenance also removes crash staging artifacts from these exact state-
namespace locations:

- `journal.json.tmp-<positivePid>-<lowercaseUuidV4>`;
- `requests/<requestId>.json.staged-<positivePid>-<lowercaseUuidV4>`;
- `results/<fingerprintHash>/<executionId>.json.staged-<positivePid>-<lowercaseUuidV4>`.

Maintenance runs only while the coordinator holds legacy authority. It commits
any expired success-index removal for that pass before it removes an artifact.
It removes an artifact only when it is a direct child with the exact writer-
generated name, a regular non-symlink file owned by the current UID, and more
than two hours old. It retains unknown names, recent files, files exactly two
hours old, future-dated files, symlinks, and non-file entries.

Startup also inspects obsolete policy or capacity namespaces under that private
root. It never removes a namespace with active requests, leases, singleflights,
or drain obligations. An idle namespace keeps recent terminal results and
success indexes for the same two-hour retention period. After they expire,
startup prunes the records and removes the empty namespace. Before any prune or
deletion recovery, startup parses the supported namespace protocol and fully
validates the journal and retained results. It leaves unsupported or malformed
namespace evidence intact and reports a warning.
Before it removes a validated empty namespace, it writes and fsyncs an exact
deletion marker. It publishes the marker from a fixed, fsynced
`.deleting-v1.staging` link. A stage-only restart cancels marker creation before
it revalidates the journal. A marker-plus-stage restart repairs marker
durability before it removes any protected entry. An interrupted cleanup
resumes only when that marker is valid, or when the namespace is already empty.
It removes the marker only after the remaining protected entries are durably
gone. It then removes the namespace and fsyncs the parent state directory.

A live coordinator with a different policy or capacity rejects the new client.
The client then waits on the shared legacy lock. It starts the new namespace
only after the prior coordinator releases that lock.

Request records include a unique request drain identity. Each lease includes a
different command drain identity. The records also include the gate owner's PID
and process start identity, the request capability digest, the worktree,
capacity weight, and named resources. Workers and mapped wrappers carry command
and request tags. Workers retain open command, request, and coordinator
generation marker descriptors. Raw capabilities and secret-bearing
environment values do not enter the journal, result files, status output,
command arguments, or coordinator logs.

The parallel parent opens the request marker before it forks a worker. In
coordinator mode, it also opens the shared generation marker for the worker.
The parent also opens a launch pipe before the fork. The worker waits until the
parent records its PID/start identity, confirms that `PGID == PID`, and fills
every cleanup registry. The coordinator journal persists the command identity.
A pure legacy parent persists that identity as a drain obligation before launch
release. The worker creates and retains its command marker only after that
recovery mapping exists and, in coordinator mode, after its lease exists. It
atomically publishes its complete result and stays
alive as the process-group leader until the parent drains that command. A crash
before lease registration therefore leaves no unreferenced command marker. A
worker still behind the launch barrier exits when its exact parent dies. A
worker released past the barrier retains its request handle for successor
recovery and its generation handle for a legacy handoff. A no-lock sentinel
retries an empty parent-identity read while that PID still exists. A crash after
registration leaves request, command, and generation recovery handles where
their lock modes provide them.

A successor coordinator reads the journal before it reuses any lease. It drops
queued command leases because their wait connections ended with the old
coordinator. It converts each granted lease to a drain obligation and keeps its
capacity and resources reserved. A joining Bash gate claims the stale request
and drains every lease's command identity. It then drains the request identity
once. Each drain persists every discovered PID and start identity and confirms
that the set is empty. Only then can it acknowledge the lease obligations and
release capacity, a named resource, the worktree lease, or the legacy lock.
The sequential and parallel paths apply the same rule after each command
wrapper and watchdog settle. A parallel drain also seeds its durable capture
from the live registered worker process group before it sends the first signal.
The active parent validates the leader's PID/start identity. Crash recovery
derives a group only from a token-holding group leader. It pins that leader's
PID/start identity before the group snapshot. Each candidate must still have
the same PID/start identity and current PGID. The drain then revalidates the
leader's PID/start/PGID identity after that candidate read. A stale numeric tag
or parent PID cannot bypass this check. The drain persists each group member by
PID/start, so it can remove a same-group descendant that closed all identity
handles without later trusting a reusable bare PGID. It drains every descendant
captured through a non-group tree walk only after it brackets a fresh child
query with the exact parent PID/start identity. Linux uses the kernel start
tick for live group, parent, candidate, and final pre-signal checks. Each
append-only capture retains the legacy `pid|lstart` line, then adds a
`runtime-v2|pid|start` metadata line that an old reader skips because its first
field is not a PID. A current reader requires that exact generation before it
signals. An interrupted legacy-only Linux capture stays unverified unless a
fresh handle or pinned relation reauthorizes it. macOS uses the calendar value
as its runtime generation. It drains every descendant
captured before detachment or still discoverable through the registered worker
group or a command, request, or generation identity before it unregisters the
worker or releases that command's scheduler lease. A
legacy run publishes its token-scoped obligation before the first signal. Each
drain refresh captures newly tagged roots before it can declare the prior set
empty. A failed drain keeps its recovery evidence and reports that the mapped
command ran.
All obligations for one request share one request-scoped drain claim. A
different process cannot acknowledge a sibling obligation while that claim is
live. PID reuse, a matching zombie owner, an unreadable identity, an unreadable
journal, or an incomplete terminal record fails closed. A zombie is stale and
does not keep an admission or drain claim live. Recovery cancels uncertain work
and gives attached followers the same non-success terminal result and payload.
It does not requeue that work or promote it to success.

The immutable terminal result is the durable completion marker. If result
creation succeeded but the following journal commit failed, a successor removes
only that execution's stale leases and drain obligations. It then reconstructs
the result-ready journal state from the exact result.

Result publication is forbidden while any command lease for that request
remains. A pre-command scheduler timeout uses
`abandon-lease --command-not-started` to remove its queued or granted lease
without creating a drain obligation. Once a command can have started,
cancellation retains its capacity and named resources until a token-scoped
drainer acknowledges `processTreeEmpty=true`.

## Alternatives considered

- **Keep the whole-run machine lock.** Rejected. It prevents contention but
  makes a short unrelated gate wait behind every command in a long gate. The
  1,710-second duration record is the measured result.
- **Use only per-worktree locks.** Rejected. Worktree files would be safe, but
  independent gates could again exhaust the machine or collide on fixed ports,
  reproducing #1802.
- **Permit a fixed number of complete gate runs.** Rejected. Each gate has its
  own parallel pool and child processes. Two admitted runs can exceed the host
  budget even when the run count is small.
- **Add only browser and build mutexes.** Rejected. Named mutexes prevent known
  state collisions, but do not bound aggregate CPU use or provide fairness and
  coalescing.
- **Give every run isolated pnpm, Trunk, Turbo, and browser caches.** Rejected.
  Cache isolation does not fix CPU starvation or a fixed port. It also removes
  safe cross-worktree cache reuse and increases disk and setup cost.
- **Run a permanent coordinator service.** Rejected. A transient process gives
  the scheduler one authority while work exists without adding an operator
  service, boot sequence, or permanent liveness dependency.

## Consequences

- Independent gate-registered lint, typecheck, and unit-test work from different
  worktrees can progress together within one machine budget.
- The same worktree still runs one full gate request at a time. This is required
  for local outputs and result files.
- Dashboard coverage, browser, and build work still run without competing gate
  commands. Their fair barrier can pause new admission while current work
  drains.
- Exact matching requests execute once. Their queue and execution results stay
  bound to one source, plan, environment, toolchain, and policy identity.
- Older worktrees still observe the legacy lock during rollout. They do not
  receive the new concurrency benefit while a legacy gate owns it. A historical
  drainer also ignores the new runtime metadata and retains its calendar-time
  PID-reuse limit until rollout completes.
- The coordinator becomes part of the local gate trust boundary. Protocol,
  journal, fairness, coalescing, disconnect, crash, PID-reuse, and descendant
  drain cases require focused regression tests.
- Worktree admission wait, combined command-scheduler wait, execution time, and
  coalesced wait must be recorded separately. The scheduler status and console
  output identify capacity, fairness, and named-resource blockers. A whole-run
  total alone hid the current bottleneck.
- Capacity 3 is a safe initial default. Change it only with the benchmark from
  #2006: one full gate plus concurrent short package gates, including an
  all-capacity dashboard phase.
- A descendant can escape recovery if it starts a new session before capture
  and closes every inherited gate identity. The gate does not support mapped
  commands that self-daemonize this way. Issue
  [#2042](https://github.com/mento-protocol/monitoring-monorepo/issues/2042)
  tracks portable containment or enforcement without signalling a reusable bare
  PID or process-group ID.
- The Bash drain rechecks the exact process identity immediately before each
  numeric `kill`, but the identity read and signal remain separate system calls.
  A PID can be reused in that final gap. Linux uses the kernel start tick to
  avoid coarse calendar collisions before the signal. macOS retains the exact
  calendar value. Issue #2042 also tracks a kernel-backed selector or containment
  boundary that removes this portable check-to-signal gap.

## Benchmark result

The final issue #2006 acceptance fixture used capacity 3 and the real Bash gate
with stubbed pnpm, Forge, and Trunk tools. The full plan changed
`pnpm-workspace.yaml`; the short plans changed one metrics-bridge file and one
integration-probes file. Each mapped full-plan tool waited 250 ms. Each mapped
short-plan tool waited 1,000 ms. This interval keeps both short commands live
through normal process-start skew. The command was
`node scripts/gate/agent-quality-gate-scheduler-benchmark.mjs`.

The legacy baseline retries only the exact pre-dispatch displacement result
once, after all initial peers settle. It first proves that the aborted attempt
started no mapped tool. The timing remains bound to the first launch. The final
run needed zero retries.

| Mode        | Elapsed    | Maximum mapped commands | Maximum active gate labels | Cross-gate overlaps | All-capacity overlaps |
| ----------- | ---------- | ----------------------- | -------------------------- | ------------------- | --------------------- |
| Legacy lock | 157,276 ms | 3                       | 1                          | 0                   | 0                     |
| Coordinator | 124,983 ms | 3                       | 2                          | 6                   | 0                     |

Both all-capacity commands in the coordinator plan had zero overlap with other
mapped tools. Short package completion improved by 81,042 ms and 119,001 ms.
The A/B label order depends on process scheduling. Total fixture time decreased
by 32,293 ms (20.5%). The short-plan queue delays fell from 93,224 ms and
128,758 ms to 4,225 ms and 4,358 ms. The separate scheduler integration suite
proves that three distinct worktrees can progress at the exact capacity of 3.

Elapsed time runs from the full gate's first mapped-tool start to the last gate
process exit. Short completion runs from short-gate launch to process exit.
Queue delay includes gate setup. These results describe this acceptance fixture.
They do not predict production gate duration.

## Evidence

- Issue
  [#1802](https://github.com/mento-protocol/monitoring-monorepo/issues/1802)
  — measured CPU starvation and dashboard coverage failures that require
  bounded resources. The browser fixture's fixed port 3211 requires a named
  resource.
- Issue
  [#1894](https://github.com/mento-protocol/monitoring-monorepo/issues/1894)
  — four-agent 1,800-second waits and the invariant that a run which executes
  nothing cannot report success through a pipe.
- Issue
  [#2006](https://github.com/mento-protocol/monitoring-monorepo/issues/2006)
  — the fair scheduling, coalescing, recovery, and benchmark requirements.
- Local `.tmp/agent-quality-gate/durations.jsonl` records captured on
  2026-08-21 — 1,710 seconds total for 14 seconds of recorded execution, and
  1,306 seconds total for about 64 seconds of recorded execution.
- Runtime files: `scripts/gate/quality-gate-coordinator.mjs`,
  `quality-gate-coordinator.sh`, `quality-gate-coordinator-support.sh`,
  `quality-gate-coordinator-policy.mjs`,
  `quality-gate-coordinator-environment.mjs`,
  `quality-gate-coordinator-client.mjs`,
  `quality-gate-coordinator-lifecycle.mjs`,
  `quality-gate-coordinator-core.mjs`,
  `quality-gate-coordinator-primitives.mjs`,
  `quality-gate-coordinator-requests.mjs`,
  `quality-gate-coordinator-scheduler.mjs`,
  `quality-gate-coordinator-server.mjs`,
  `quality-gate-coordinator-startup-attestation.mjs`,
  `quality-gate-coordinator-socket.mjs`,
  `quality-gate-coordinator-state.mjs`,
  `quality-gate-coordinator-legacy.mjs`,
  `quality-gate-coordinator-journal.mjs`,
  `quality-gate-coordinator-journal-fields.mjs`,
  `quality-gate-coordinator-drain.mjs`,
  `quality-gate-coordinator-result-record.mjs`,
  `quality-gate-coordinator-results.mjs`, and
  `quality-gate-coordinator-retention.mjs`.
- Test and benchmark files: `scripts/agent-quality-gate.test.sh`,
  `scripts/gate/quality-gate-coordinator.test.mjs`,
  `quality-gate-coordinator-policy.test.mjs`,
  `agent-quality-gate-scheduler.integration.test.mjs`,
  `agent-quality-gate-scheduler-benchmark.mjs`,
  `agent-quality-gate-scheduler-fixture.mjs`,
  `agent-quality-gate-scheduler-fixture-support.mjs`,
  `agent-quality-gate-fixture-processes.mjs`, and
  `agent-quality-gate-scheduler-tool-fixture.mjs`.
- Integration entry point: `scripts/agent-quality-gate.sh`.
- Related decision: [ADR 0007](0007-agent-quality-gate-and-merge-oracle.md),
  which owns why the local gate is required before push.
