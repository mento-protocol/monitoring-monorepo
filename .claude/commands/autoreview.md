# Auto Review

Run the repo-local structured closeout review helper. Normal shells default to
the Codex review engine; active Codex sandbox sessions default to the helper's
local deterministic engine only when no engine is passed explicitly. An
explicitly selected unavailable engine fails closed. Pass `--engine claude`
when the user explicitly asks for Claude review.

Arguments: `$ARGUMENTS`

## Steps

1. Freeze the original request, target/owner, changed files, and non-test
   changed-line count as the scope baseline. Classify later additions as
   in-scope, follow-up, or stop; create an issue before deferring valid
   follow-up work and warn near twice the baseline.
2. Run:

```bash
pnpm agent:autoreview $ARGUMENTS
```

For a fresh-context Codex handoff, pass
`--prepare-bundle-dir /tmp/autoreview-bundle` using a directory outside the repo
worktree. Add `--feedback-pr <number>` when reviewing a feedback-fix batch.
The bundle parent must already exist. Every canonical ancestor must be owned by
the current user or root; group/other-writable ancestors require sticky-bit
protection. On macOS, write-granting ACLs on parent ancestors or bundle entries
fail preparation or verification. The adapter pins the freshly created staging
directory's `dev:ino` before content generation and rechecks it throughout
transfer. It manifests wrapper-owned evidence around helper
execution and all evidence around the final helper source check, rejects
externally linked regular files, exclusively reserves the destination, and
writes `.agent-autoreview-complete` last with the verified manifest digest. Run
`pnpm agent:autoreview --verify-bundle-dir /tmp/autoreview-bundle` immediately
before reading every pass and retain its printed digest outside the bundle.
After review, rerun with
`--expected-bundle-manifest <retained-digest>`; this rehashes the no-follow
evidence and fails if the marker, content, or pre/post digest changed. Never
review an interrupted or unverified bundle. The bundle owns its
`autoreview-prompt.md`; do not combine this mode with `--bundle-output`.
Direct supplemental evidence must be repo-relative;
wrapper-generated feedback and protected-main checklist copies inside the
trusted bundle directory are the exceptions. The owning-checkout default
semantic helper and automatic feedback execute Node runtime from that same
pinned `origin/main` object rather than a PR-selected base, mutable worktree, or
package script; wrapper-owned Node launches discard `NODE_OPTIONS` and
`NODE_PATH` plus loader/startup injection variables. Direct executables require
trusted ownership and non-shared-writable ancestry. On Darwin, Homebrew-style
paths are accepted only through sealed private native Mach-O snapshots with
system-only library closure. On Linux, a root-run wrapper may recover only the
exact path-untrusted Node inode (including root- or foreign-owned writable or
hard-linked toolcache layouts) from a live, uninterrupted all-root ancestor
chain; direct helper invocation gets no such exception. The wrapper seals the
exact inode and its validated glibc startup closure, then the helper revalidates
the snapshot, sealed manifest, loader, and alias handoff before and after
semantic-engine launches. Scripts and unsafe
library closure fail closed.
The helper reviews the complete target
without truncation. Reviewer network search is off by default; pass
`--web-search` only when the review explicitly needs public documentation
lookup. Direct semantic engines
fail closed if more than one prompt is required; prepared bundles retain
bounded lossless passes that one fresh-context reviewer must inspect
completely. Semantic engines use an isolated empty workspace, sensitive inputs
fail closed, and a quiet reviewer emits a 60-second heartbeat.
Do not pass the removed `--parallel-tests` option; run tests through the quality
gate.

If this checkout changes the executable autoreview runtime and the owning
adapter refuses its self-review, keep the refusal intact. Invoke a clean,
detached, compatible wrapper/helper from the last independently reviewed
pre-change commit while the current directory remains this reviewed checkout,
then use that same trusted wrapper for both manifest checks. Follow the exact
sequence in `docs/notes/agent-quality-gate-mechanics.md`; never point the trusted
paths at this runtime-changing checkout.

3. Verify every accepted finding before editing. Do not blindly apply review
   output.
4. If fixes are made, rerun focused checks and autoreview for the fixed batch.
   Pause for scope reclassification after two review-triggered patch cycles
   rather than starting a third automatically.
5. Treat a clean result as source review, not UI, CLI/API, generated-artifact,
   or runtime proof. Keep every applicable browser, quality-gate, and runtime
   verification step.
6. For PR work, do not call the PR clean until
   `pnpm pr:ready-state --pr <number> --json` is ready; in a capable Claude
   cloud variant add `--repo <owner/name>` (gh cannot infer the repo from
   the proxy remote). In a Claude cloud session without the REST + GraphQL +
   `--slurp` capability gate the probe cannot run; run the MCP emulation
   checklist from the `babysit-pr` skill instead, label the result
   MCP-emulated rather than probe-verified, and leave the probe-verified
   all-clear to a gh-capable surface
   (`docs/notes/github-tooling-surfaces.md`).
