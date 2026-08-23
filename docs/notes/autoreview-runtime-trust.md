---
title: Autoreview Runtime Trust Model
status: active
owner: eng
canonical: false
last_verified: 2026-08-23
doc_type: reference
scope: repo-wide
review_interval_days: 180
garden_lane: package-readmes-reference
---

# Autoreview Runtime Trust Model

This note is background on the defenses `scripts/agent-autoreview*` enforces:
which runtime may execute a review, what evidence it may capture, and how a
prepared bundle proves it was not tampered with. Every check described here
fails closed — one that cannot prove its property stops the review instead of
degrading it — and none of them is an operator knob. The operator contract
(invocation, engine selection, prepared-bundle commands, and the
trusted-checkout procedure for runtime-changing PRs) lives in
[`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md).

## Input budget and target freezing

The direct helper and prepared-bundle adapter enforce one cumulative input
budget while capturing diffs, untracked files, checklists, and feedback, before
those bytes can accumulate in memory or staging sidecars.

Every Git invocation pins `-c diff.renames=false`, so no capture inherits a
rename policy from operator configuration and each one states its own. The patch
and stat captures pass `--find-renames` at Git's default similarity floor, which
overrides that pin: a branch that relocates many files otherwise bundles as
delete+add pairs and exhausts the budget before analysis runs, and a stat that
disagreed with the patch it indexes would misreport the change. Content is
elided only at similarity index 100%, and rename detection pairs an added path
only with a deleted one, so a header can never stand in for content the change
introduces. A relocation carrying edits emits its hunks, which are bundled,
chunked, and scanned like any other change; a relocated binary is reviewable
only while it is byte-identical, and one that also changes still fails closed.
Those captures also own the rename candidate limit as `-l5000`, because the
reviewed repository's own config can still set `diff.renameLimit`, and a move
that changes a basename and edits the file needs the exhaustive pass Git skips
past its default candidate count. The pin stays finite because that pass runs
before any byte reaches the capture limiter, so no output bound can cut it
short. What bounds it is the gate Git applies: the exhaustive pass is skipped
once the number of unpaired sources multiplied by the number of unpaired
destinations exceeds the square of the limit. `-l5000` therefore authorizes at
most 25,000,000 pair comparisons, whatever the reviewed change looks like.
Past that product Git says on stderr that detection was skipped and these
captures fall back to delete+add pairs, rather than stalling. Those pairs still
review correctly; a large enough one fails on the capture budget with its own
message.

This repository declares no minimum Git version, and the default the pin
replaces has moved: `diff.renameLimit` documents 400 in older Git and 1,000
today. Nothing here depends on which one a host ships, because the pin overrides
both — an explicit `-l` wins over the config and over the built-in default, and
5,000 is above either. The bound above was validated against Git 2.54.0, where
2,000 symmetric candidates pair under `-l5000` and are skipped without it. As
one machine-specific observation rather than a guarantee: on that host, 5,000
symmetric candidates of 50 KB blobs took about 74 seconds at the product
ceiling, against 272 MB of restated diff with detection off. Elapsed time
depends on hardware and blob size; the comparison count does not.

Both bounds above limit output, not work. Git reads and diffs every changed
blob before the first byte reaches the limiter, and the candidate gate caps
comparisons rather than seconds, so a pathological repository state, a hung
filesystem, or a Git defect can hold a capture open past either. One wall-clock
budget bounds that work: 600 seconds, spent across every capture a run performs,
enforced separately in each runtime, and each capture may take only what is left
of it. The wrapper's captures are one contiguous stage, so its first capture
fixes an absolute deadline and the stage as a whole cannot outlast it. The
helper's Git spawns bracket a semantic review that may legitimately run for half
an hour, so there the budget is the time those spawns actually take, and the
review cannot consume what the post-review fingerprint still needs. The helper
measures on a monotonic clock, so no clock adjustment reaches its accounting; no
monotonic clock is available to the wrapper's shell, so a clock it cannot read,
or one that moves backwards inside a stage, refuses the capture rather than
restarting the stage on a fresh full budget. A capture that reaches the bound
refuses by stage name and elapsed time and produces no bundle; it is never
published partially and never skipped silently. Nothing the capture started
outlives that refusal: the wrapper runs each capture as its own process group
and SIGKILLs that group at the deadline, with no SIGTERM grace, because a grace
period would run past the bound. Its interrupt path is the one that escalates,
since an interrupted capture is not bound by the deadline. The helper spawns
detached and sweeps the group after every capture, and registers terminal-signal
handlers before it detaches anything: a caught signal cannot kill it
mid-capture, so the deadline still fires and still reaps the tree, where a fatal
one would strand a group no longer reachable from the terminal. The one capture
the budget does not wrap is the PR feedback state, which already carries its own
wall-clock bound; that bound is clamped to what the shared budget has left,
minus the second that bound spends escalating, and the time it spends is charged
there, so it cannot carry a run past the ceiling either.

What the budget covers is the captures themselves: the wrapper's stage begins at
its first capture, and in the helper it covers every Git spawn. Three things sit
outside it, and none of them is bounded by anything else. The wrapper's own
target-selection and runtime-materialization Git reads run before the stage
opens, inside command substitutions that cannot stream a killable job. The
helper's untracked-file reads are synchronous, so a wedged mount blocks the
process itself and no timer of its own can run. And a process already wedged in
uninterruptible I/O reaches neither runtime's SIGKILL: the refusal still fires on
time and still publishes nothing, but that process ends when its I/O does.
Putting every capture behind a supervisor that could abandon it would convert
that last case from a visible hang into a silently abandoned process holding the
same resources, which is why it is not done. The number is a ceiling, not a statement about how long a capture takes:
a 1,000-commit, 23.8 MB branch diff of this repository captures in about a
second, and the deadline promises nothing about elapsed time beyond the bound it
enforces. Its default is the one value in this
note an operator may set, alongside the other deadlines in the operator
contract, because moving a liveness bound cannot make a review accept evidence
it would otherwise refuse.

The changed-path captures keep the pin, so both sides of a move stay enumerated
for the sensitive-path refusal and checklist routing. The scope baseline splits
the difference on purpose: its changed-file count comes from that rename-blind
enumeration and counts both sides of a move, while its non-test line count is
rename-aware, so the prompt states how many paths a change touches beside how
many lines it actually changes. Rename detection works within one diff, so a
move whose two sides are split across commits has no pair to find: review that
branch in branch mode, where both sides sit in the same diff.

For a real review, the helper resolves a symbolic branch base or commit target
once to an immutable object ID. Direct `--dry-run` instead reports the requested
ref without resolving or freezing it. Source fingerprints cover the symbolic
branch or detached state, `HEAD`, and staged/unstaged bytes. They include
untracked file or symlink state only when local working-tree content is part of
the selected target (`local` or the adapter's branch-local target); explicit
branch and commit snapshots ignore unrelated untracked files. The repo adapter
first brackets target selection with a lightweight `HEAD`/branch/status
fingerprint, so concurrent dirty-state or checkout changes still fail closed
without reading untracked file contents. After the target is frozen, explicit
branch and commit reviews use only the target-scoped source fingerprint, so
unrelated untracked churn cannot invalidate them; automatic mode retains the
status guard because its selected target depends on clean/dirty state. Every
Git path collection uses NUL-delimited output, so enumeration does not depend
on Git quoting or newline splitting.

The adapter also resolves `origin/main^{commit}` once to an independently
protected baseline and sources checklist policy only from that pinned object ID
in every target mode. Checklist edits in a local target, PR-selected base,
current head, or selected commit stay visible as diff evidence but cannot
rewrite the policy used to review themselves.

When prepared-bundle feedback selection is `auto`, the adapter materializes the
feedback-state Node runtime from that same pinned protected-main object ID,
never from the PR-selected base, current `HEAD`, or a selected commit's parent.
Prepared-bundle generation fails closed when that protected baseline is
unavailable; feedback capture also fails when its bounded regular runtime blobs
are unavailable. It executes the pinned runtime directly from the repo root with
frozen canonical `--repo` routing; no reviewed package script or pnpm lifecycle
runs. Before publication it also verifies that the feedback ledger still names
that PR, base branch, current head branch, and frozen head object ID.

## Pinned runtime and executable ancestry

The adapter requires the current shell adapter's bytes and executable mode to
match frozen `HEAD`. In every target mode it requires the shell, MJS helper, and
core at that frozen `HEAD` to match the pinned protected-main object, then
executes MJS files materialized from that protected object instead of a
PR-selected base or mutable worktree. Commit mode also requires the selected
commit's executable runtime to match the protected baseline. Local and
branch-local prepared bundles require helper/core worktree bytes to match frozen
`HEAD`. Any dirty or committed runtime change fails closed and must be reviewed
from a separate trusted checkout with an explicit compatible
`AUTOREVIEW_HELPER`. Direct default-helper execution in the owning checkout uses
the same frozen-`HEAD` and protected-main checks and materialized MJS runtime.

Wrapper-owned Node launches, including executable discovery and validation
helpers, discard `NODE_OPTIONS` and `NODE_PATH`, plus dynamic-loader and
interpreter startup-injection variables, so ambient hooks cannot run before the
pinned helper. An explicit helper from a separate checkout remains an explicit
trust decision. The adapter also requires the physical checkout root to match
Git's top level, removes reviewed-repo directories from its executable search
path, and runs bare shell utilities from the system path. The helper searches
`AUTOREVIEW_<COMMAND>_BIN`, then that path, then well-known install directories
so a thin caller `PATH` cannot hide an installed engine; those extra directories
are search order only and grant no trust of their own. Direct Git, Node,
GitHub CLI, and semantic-engine executables and every canonical ancestor must be
owned by the current user or root and must not be group/other-writable. Node
discovery never executes a version-manager shim: Volta is queried through a
sealed native `volta which node`, and the returned Node path is revalidated
before launch. Git invocations ignore inherited repository-routing variables
such as `GIT_DIR` and `GIT_WORK_TREE`.

On Darwin, Homebrew-style paths that fail only that ancestry rule are accepted
solely through sealed private snapshots of native Mach-O executables whose
linked-library closure is entirely system-only.

### The hard-linked engine binary, and why the fix stays manual

A semantic-engine executable with more than one hard link is refused, and both
routes require it: direct execution needs `nlink === 1` or root ownership, and
the Darwin snapshot fallback requires `nlink === 1` outright
(`agent-autoreview.mjs:1093,1124`). The rule is doing real work. The wrapper's
guarantee is that the inode it validated is reachable only through the directory
ancestry it inspected; a second link is a second name in a directory it never
looked at, so the ancestry proof does not cover the file. Root ownership
substitutes for that proof, which is why the `uid === 0` branch exists.

This is reachable in ordinary use, not just in theory. Claude Code's own
auto-updater has left `~/.local/share/claude/versions/<version>` with
`nlink=2`, and `pnpm agent:autoreview -- --engine claude` then fails with
`claude CLI is not available outside the reviewed repo` — the message names the
search path, so it reads as "not installed" while the binary is present and
runnable. It can come back after any update.

**The wrapper must not repair this itself.** A same-path `cp` + `mv` inside the
adapter would be safe as a shell command and wrong as wrapper behaviour, three
ways. It gives a read-only validator write authority over the toolchain it
validates, which is the trust direction this whole document argues against. It
launders an inode the wrapper has just declined to trust into the trusted path
by copying its bytes there — the nlink rule denies exactly that inference, and
re-deriving it one line later does not make it true. And it edits an installer's
bookkeeping from underneath it: the remaining link keeps the ORIGINAL inode, so
a package manager that hard-links versions for de-duplication silently stops
sharing storage, and any integrity check it keeps over that inode now describes
a file the wrapper no longer runs.

So it is an operator step, run deliberately, on a path the operator has looked
at:

**Ask the wrapper which file it means — do not guess with `command -v`.** The
helper searches `AUTOREVIEW_<COMMAND>_BIN`, then `PATH`, then well-known install
directories, and `command -v claude` can resolve to something else entirely: on
one machine here it returned a `cmux-cli-shims` wrapper in `$TMPDIR` with its own
`nlink=1`, so checking it would have reported a healthy link count for a file the
autoreview wrapper never runs. The refusal message prints every path it probed,
in order, and the engine is normally the versioned file under
`~/.local/share/claude/versions/`:

```bash
# 1. Read the "Probed:" list out of the refusal.
pnpm agent:autoreview -- --engine claude

# 2. Check the link count on the path the wrapper named.
#    macOS: stat -f '%N nlink=%l mode=%Sp'    GNU: stat -c '%n nlink=%h mode=%A'
engine=~/.local/share/claude/versions/<version>
stat -f '%N nlink=%l mode=%Sp' "$engine"

# 3. Repair, only when nlink is greater than 1. Same directory, mode preserved,
#    atomic replace.
cp -p "$engine" "$engine.unlinked" && mv "$engine.unlinked" "$engine"
```

Both `stat` spellings are given because the flags are not portable, and neither
is `readlink -f`: it works on current macOS but is absent from the BSD
`readlink` on older releases, and this repository declares no minimum macOS.

Verified on a scratch file rather than on a live install: `nlink` goes 2 → 1,
the bytes compare equal, the mode survives, the file still executes, and the
sibling name keeps the original inode. Re-run the check after a CLI auto-update;
the `--engine codex` path is unaffected either way, so a blocked
`--engine claude` is never a reason to skip the closeout review.

## Linux root recovery, ELF validation, and loader control

On Linux, and only for a root-run wrapper, an otherwise path-untrusted Node may
be recovered only when its inode matches a live wrapper ancestor across an
uninterrupted all-root UID chain; this includes root- or foreign-owned
writable/hard-linked toolcache layouts, while set-ID semantics remain forbidden.
Direct helper invocation receives no runtime exception. The wrapper copies bytes
from the bound `/proc/<pid>/exe` descriptor into a root-owned `0500`,
single-link snapshot, then re-hashes both the ancestor and candidate descriptors
before launch.

Bounded ELF parsing rejects unsafe interpreters, RPATH/RUNPATH and
loader-injection tags, and path-qualified dependencies. The glibc-only fallback
recursively resolves every static `DT_NEEDED` name to a root-owned,
non-writable target, publishes those names through a private `0700` alias
directory, and launches with that exact controlled `LD_LIBRARY_PATH`;
`/etc/ld.so.preload` must remain absent. The helper reproduces the
wrapper-sealed loader path/symlink/stat/content fingerprint and validates the
handed-off current snapshot, sealed manifest, loader, alias names, targets, and
ancestry before and after semantic-engine launches. This exception trusts the
UID-0 wrapper/runtime and covers the static startup closure, not later
application-level `dlopen`, provider, or plugin loads. Scripts and native
executables with relative or non-system library closure fail closed.

## The `autoreview-root-runtime` CI job

The required `autoreview-root-runtime` CI job is the focused Linux/root proof.
It selects the repository's Node version through Blacksmith's x64
`/opt/hostedtoolcache` layout, launches that exact runtime through `sudo` and a
minimal `env -i`, and requires the target-guard suite to observe the sealed
snapshot rather than silently taking the ordinary trusted-path branch. The job
does not install workspace dependencies or run the full autoreview suite. Its
test-only diagnostic switch retains only the deepest allowlisted trust stage,
prints that one stage if Node resolution fails, and is unset before the helper
or semantic engine starts; normal invocations keep the generic trusted-Node
error.

## Prepared-bundle staging, manifests, and cleanup

Prepared repo-context bundles apply the same target-scoped before/after
fingerprint while every artifact remains in an adjacent ephemeral directory. The
destination parent's canonical inode and the freshly created staging directory's
`dev:ino` are pinned before content generation. After the wrapper stages its
evidence, it manifests that evidence before and after the helper runs, excluding
only the helper-owned prompt and metadata outputs. After prompt validation, the
adapter also hashes the complete staged evidence before and after the final
helper source-fingerprint call. It rejects symlinks, special files, externally
linked regular files, and any identity or content change. The validated Node
runtime exclusively reserves the destination, rechecks the staging identity
throughout transfer, and verifies the same manifest after transfer and again
immediately before hard-linking `.agent-autoreview-complete` last. That marker
contains the manifest digest, which `--verify-bundle-dir` reopens without
following symlinks and checks against the manifest. A destination created during
the final race window is never replaced.

Failures before an explicit helper runs, plus failures from the wrapper-attested
default helper runtime, receive pinned-identity cleanup. The adapter atomically
moves the candidate into a random adjacent quarantine, opens the moved directory
without following symlinks, verifies its recorded `dev:ino`, and pins that inode
with `fchdir` before recursive deletion. Later pathname cleanup is non-recursive
and fails closed on identity drift. Once an explicit `AUTOREVIEW_HELPER` has
run, however, the adapter retains failed staging without recursive deletion: an
unattested helper may leave a same-UID writer that can substitute child
directories even beneath a descriptor-pinned root. Canonical secret-scan
failures use the attested helper and therefore do not leave raw diff sidecars
behind. It cleans up its private marker while its inode still matches, but never
recursively deletes a failed destination reservation. The mutable repo helper is
not re-entered for publication. The published `helper-output.txt` reports the
final prompt/pass paths, never the discarded staging directory. A detached
producing wrapper can verify the bundle from a non-Git working directory. On
macOS, preparation, publication, and verification also reject write-granting
extended ACLs on every canonical parent ancestor and bundle entry; those ACL
checks bracket evidence hashing.

Prompt-index validation normalizes a UTF-8 BOM, CRLF line endings, and leading
blank lines before applying the strict pass-order and companion-file checks, and
rejects any undeclared extra pass file. Direct `--bundle-output` publication uses
an exclusive same-directory link and refuses to replace any existing
destination, including a file created during the final publication race window.

## Semantic-engine isolation and credential snapshots

Semantic Codex and Claude passes run from an empty temporary workspace with
repo/project instructions, hooks, plugins, and inherited environment restricted
to the review contract. Reviewer credentials remain available only to launch
the selected engine; repository tooling and unrelated environment state do not.
For Claude/Bedrock this includes standard AWS web-identity and container
credential-chain inputs. Explicit `AWS_CONFIG_FILE` and
`AWS_SHARED_CREDENTIALS_FILE` locators opt into trusted static/profile files;
their private snapshots reject `credential_process`. When either locator is
absent, the helper supplies a private empty snapshot so the AWS SDK cannot fall
back implicitly to `~/.aws/config` or `~/.aws/credentials`; users who need
those files must set the locators explicitly. Claude's other file-valued cloud
credential/config locators, plus `SSL_CERT_FILE` for both Claude and Codex,
must resolve outside the reviewed repository to a root- or reviewer-owned
regular file with no shared-write mode, unsafe non-sticky ancestry, or
write-granting ACL. The helper opens each explicit source no-follow, revalidates
its identity and ancestry while copying it into a private per-run `0600`
snapshot, and passes only that snapshot to the selected engine. Snapshot files
are removed with the engine workspace during normal completion and partial
setup failure. On process interruption they are identity-checked and unlinked
before the bounded process-group termination path settles, so even an escaped
descendant holding reviewer pipes cannot retain a credential path or block
parent termination. An untrusted or repo-contained source fails closed before
the selected engine starts. Semantic autoreview rejects non-empty `SSL_CERT_DIR`
because a directory of trust anchors loaded on demand cannot be frozen safely;
unset it or provide a trusted external PEM bundle through snapshotted
`SSL_CERT_FILE`. Closure of the direct engine leader triggers immediate
`SIGKILL` for its remaining process group before tracking or escalation timers
are released, including ordinary success and failure as well as timeout or
interruption.

The Claude engine additionally receives `USER`, because Claude Code builds its
macOS Keychain account name from that variable and reports an expired OAuth
session when the lookup misses. The helper derives the name from its own process
credentials rather than the inherited value, and drops it when the name falls
outside the portable username character set, so a hostile parent environment
cannot steer the Keychain lookup. The Codex engine environment does not carry
it.

The narrow trusted exceptions to the repo-relative supplemental-evidence rule
are adapter-generated feedback state and protected-main checklist copies inside
the prepared-bundle directory. Sensitive paths, credential-like content, private
keys, wallet recovery phrases, Stripe live keys, common Slack/Discord/Telegram
webhook URLs, and secret-bearing URL query parameters fail closed before any
prepared-bundle artifact is published or review input is sent to a semantic
engine. A value that only names a credential is a reference, not a literal, and
passes: environment and `process.env` reads, GitHub Actions `${{ … }}` context
expressions, Terraform `var`/`local`/`module`/`data` traversals, and shell
parameter expansions such as `${GH_TOKEN:-${GITHUB_TOKEN:-}}` whose default
(`:-`, `-`), assign (`:=`, `=`), alternate (`:+`, `+`), or error (`:?`, `?`)
word is empty or itself a shell-native reference. Every one of those is anchored
to the whole value, so a literal fused to a reference still refuses. Shell
expansion nesting is bounded at eight levels, past which the value is not a
reference and stays subject to the literal rules; real defaults nest one to
three deep, and an unbounded walk lets one crafted line exhaust the scanner's
stack. Three more shapes pass on the same proof, and only unquoted. The scanner
sees no file type, so each carries a syntactic discriminator: HCL iteration
traversals (`each`, `count`, `self`, and the `rule` dynamic-block iterator) as
bare dotted identifier paths behind a whitespace-surrounded `=`, which a shell
assignment cannot take; a TypeScript type annotation in `:` position whose
union or intersection members all come from a closed twelve-word keyword
vocabulary, so the value cannot carry a credential in any language, split
across members or whole; and a shell command list on an `=` value whose head is
a command substitution read by word position — a command name of separator-split
segments each under credential length, then arguments each bounded whole by that
length, whether a shell reference, a flag with its optional value, or a bare
word — followed by a `||`/`&&` tail of whole words under it, drawn from an
alphabet with no `=`, `:`, quote, `$`, or parenthesis. A literal argument, one
split across separators, one wearing a `--` prefix, and a second assignment in
the tail all fail closed. So do two shapes that carry nothing: a head that is a
call expression rather than a substitution, and an argument over that length,
such as a deep path. Both refuse today too, so nothing regresses; they are the
price of a rule that proves inertness from syntax alone.
A literal in value position stays refused whatever names it: a fixture
string is a quoted literal, and no syntax separates one from a weak credential.
Composing the value from parts is not a general escape. `staticConcatenation`
folds adjacent literals back together before the credential-key rules run, so a
credential-named key holding two concatenated halves refuses exactly as the
fused literal does (measured — an example written out here re-trapped this very
file). Composition clears only provider-prefix patterns — `ghs_…`,
`sk-ant-…` — bound to an identifier the scanner does not read as a credential
name; the same prefix written whole still refuses. Author fixtures with a
documented placeholder marker (`fixture-token`, `example-secret`,
`example-secret-value`), or with a non-credential-named identifier, and reach
for composition only for a provider prefix that has to stay recognizable.
`docs/adr/0068-sentry-fixture-authoring-policy.md` is the policy and the
`scripts/sentry/fixture-scan-canary.test.mjs` canary that enforces it.
Evidence reads reject symlinks and verify that the opened descriptor still
identifies the file that was inspected, closing path-swap races.

## Explicit helper attestation

Source fingerprints and untracked-file serialization remain wrapper-owned
operations executed by the attested helper; a trusted wrapper physically outside
the reviewed checkout copies its sibling helper/core no-follow into the private
command runtime and binds that snapshot to an identity plus full content
manifest before use. The source directory is descriptor-pinned across both
copies; its POSIX ancestry, source identities, and macOS ACLs are stable and
non-write-granting before and after the copy. This attestation also applies when
an explicit `AUTOREVIEW_HELPER` resolves to that external wrapper's own default
sibling helper, as in the runtime-review command in the operator runbook.

An explicit replacement cannot run before wrapper-owned recursive cleanup is
finished. After that handoff, the wrapper performs no recursive cleanup and
retains its command runtime plus failed staging because the replacement may have
left a same-UID writer.
