---
title: Autoreview Runtime Trust Model
status: active
owner: eng
canonical: false
last_verified: 2026-07-29
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

The narrow trusted exceptions to the repo-relative supplemental-evidence rule
are adapter-generated feedback state and protected-main checklist copies inside
the prepared-bundle directory. Sensitive paths, credential-like content, private
keys, wallet recovery phrases, Stripe live keys, common Slack/Discord/Telegram
webhook URLs, and secret-bearing URL query parameters fail closed before any
prepared-bundle artifact is published or review input is sent to a semantic
engine. Evidence reads reject symlinks and verify that the opened descriptor
still identifies the file that was inspected, closing path-swap races.

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
