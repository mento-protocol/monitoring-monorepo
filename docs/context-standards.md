---
title: Agent Context Standards
status: active
owner: eng
canonical: true
last_verified: 2026-07-29
doc_type: reference
scope: repo-wide
review_interval_days: 90
garden_lane: package-readmes-reference
---

# Agent Context Standards

This repo treats context as part of the product. Source code is what runs in production; context is what agents use to decide how to change it.

## Authority Map

### Canonical Context

Canonical context describes the system and operating rules as they are today. Agents may rely on it when making implementation decisions.

- `AGENTS.md` and nested `*/AGENTS.md` files: operational instructions scoped to the repo or a directory.
- `SPEC.md`: the technical specification of the monitoring system's architecture, data flow, and endpoints.
- `docs/adr/*.md`: architecture decision records — the _why_ behind the system's shape. Each in-force ADR is current operating truth; superseded ones carry `status: archived`. The index is `docs/adr/README.md`.
- `docs/pr-checklists/*.md`: mandatory review checklists for known hazard classes.
- `docs/deployment.md`: current deployment workflow.
- `.agents/skills/**/SKILL.md`: reusable agent procedures.
- `.agents/roles/*.md`: opt-in role definitions for verification and standards review.
- Package READMEs when they describe current commands or runtime behavior.
- Root `README.md`: the repo landing page and current setup/operator overview.
  It uses an invisible `agent-context` HTML comment for metadata so GitHub does
  not render a raw YAML frontmatter block on the repo homepage.
- `docs/notes/*.md` files that canonical files explicitly delegate current
  operating rules to. These notes must carry `canonical: true` frontmatter and
  are enforced like other canonical docs.

Canonical context must stay internally consistent. If two canonical files conflict, fix the conflict before relying on either one.

### Non-Canonical Context

Non-canonical context is useful history, intent, notes, or hypotheses. Agents may read it for rationale, but must verify current behavior in code, config, deployment state, or canonical docs before acting.

- `docs/PLAN-*.md`
- `docs/notes/*.md` files without `canonical: true` frontmatter
- archived docs
- roadmap/backlog entries
- historical PR review notes

Non-canonical context is allowed to be stale or contradictory. It should not be copied into canonical files without re-verification.

## Documentation Catalog

[`docs/README.md`](README.md) is the generated navigation index for every
unique Markdown surface in the proposed working tree: tracked files plus
non-ignored untracked additions, minus working-tree deletions. It excludes `CLAUDE.md` and
`.claude/skills/**` runtime mirrors because their canonical sources are
`AGENTS.md` and `.agents/skills/**` respectively. Regenerate the catalog with
`pnpm docs:index --write`; `pnpm docs:index --check` fails when the index is
stale or an internal Markdown target is broken.

The catalog makes documents discoverable; it does not promote them. Its
`canonical`, `non-canonical`, and `unmanaged` labels are derived from each
document's metadata under the authority rules above.

The committed catalog intentionally stays lean: lane headings, authority labels,
navigable source paths, ADR titles for numeric decision records, non-active
lifecycle markers, and runtime-source pointers. Full metadata remains in each
document and the JSON inventory. Volatile analytics such as word counts and
inbound-link counts remain available from `pnpm docs:index --json` and
`pnpm docs:audit`; they are not committed into the catalog, so prose-only edits
do not churn this shared file.

## Metadata Contract

Managed context files use YAML frontmatter with `title`, `status`, `owner`,
`canonical`, and `last_verified` for canonical files. README files may use the
same keys in an invisible HTML comment so GitHub does not render a frontmatter
block:

```html
<!-- agent-context: title="Mento Monitoring Monorepo" status=active owner=eng canonical=true last_verified=YYYY-MM-DD doc_type=reference scope=repo-wide review_interval_days=90 garden_lane=package-readmes-reference -->
```

Rules:

- `canonical: true` means the file is current operating truth.
- `canonical: false` means the file is history, intent, or notes.
- `owner` is the accountable reviewer for future cleanup.
- `last_verified` is required for every canonical file and records the last semantic verification against its owning source.
- `pnpm agent:context-check` fails once a `canonical: true` file's `last_verified` is more than 90 days old. Re-verify the content and bump the date; don't extend the window to make the check pass.

The catalog also classifies every document with `doc_type`, `scope`,
`review_interval_days`, and `garden_lane`. Canonical documents must declare all
four fields explicitly. Non-canonical and unmanaged documents may rely on the
path defaults tested in `scripts/docs-index-helpers.mjs`; explicit metadata can
override those defaults. Canonical context normally uses a 90-day semantic
review interval. Classification controls routing and gardening only; it never
overrides `canonical` authority.

### Claude runtime registry

Claude agents, commands, and security-review guidance use runtime-specific
frontmatter or prompt text. Do not add generic documentation metadata to those
files. Their seven supported paths are instead registered in
[`claude-runtime-document-registry.json`](claude-runtime-document-registry.json).
Each entry is non-canonical, active, owned, classified, and points to one or
more canonical sources. The catalog and garden packet render those pointers so
runtime projections do not become an authority source themselves.

When adding, removing, or moving one of those runtime files, update the
registry in the same change. `pnpm docs:index --check`, `pnpm docs:audit`, and
`pnpm agent:context-check` fail if the registry is incomplete, has an invalid
entry or source, or no longer matches the proposed runtime-file set. Keep this
registry limited to its seven named Claude runtime documents; use normal
frontmatter for other managed Markdown.

## Placement Rules

- Put instructions at the most specific directory that fully owns them.
- Move instructions upward only when multiple directories genuinely need them.
- Put repeatable procedures in `.agents/skills`, not in long root prose.
- Put verification personas in `.agents/roles`; roles are opt-in and do not run automatically.
- Keep root `AGENTS.md` small enough that every line earns its default-token cost.
- State current operating rules only. Status narration, completed-migration
  notes, run links, and dated proof belong in the ADR or PR that shipped the
  change.
- Where a file already links an owning authority, keep at most a one-line gist.
  Never restate that authority's procedure, command block, or rule list.
- In agent instruction files (`AGENTS.md` and scoped routers), do not describe
  what code does. State the non-obvious constraint, and where a linter, test,
  or CI gate enforces it, name the enforcing check instead of restating its
  logic. Reference documents such as `SPEC.md` and package READMEs still own
  behavior and architecture descriptions.

## Change-coupled drift audit

When a PR adds or changes a command, script, environment variable, hook,
deploy/rollback step, or canonical operator workflow, audit every live entry
point that can still teach the old sequence. Search root and package
`AGENTS.md`, README files, `docs/**`, `.agents/skills/**`,
`.claude/skills/**`, `.claude/commands/**`, workflows, and related deploy,
rollback, and babysit scripts. Update stale ordered runbooks and stale
file/directory descriptions in the same PR.

Treat workflow-generated issue bodies and operator instructions as live entry
points: compare their rules item by item with the canonical owner before the
first push.

Treat deploy, rollback, and babysit as one workflow family: a new promotion or
verification gate normally belongs in each applicable path. Search for the old
command or invariant after editing and inspect every remaining hit; a concise
router is not permission to leave a detailed owner stale.

## Maintenance Checks

Run `pnpm agent:context-check` to verify managed metadata (including the
`last_verified` staleness window), scoped AGENTS coverage, skill mirrors, and
Cloud Run revision suffix guardrails. Run `pnpm docs:index --check` for catalog
drift and broken internal links. Run `pnpm agent:context-budget --strict` to
enforce a 10 KiB root-file cap, 9 KiB per scoped file, and 18.5 KiB per combined
root-to-directory route. The report warns at 90% and includes the blank-line
separators Codex inserts between layered files. These limits deliberately stay
below Codex's truncation boundary; route detail into the narrowest canonical
note, checklist, or skill instead of raising them. Each cap is the measured
maximum plus about 35% headroom, rounded up to a 512-byte step, and ratchets
down only; `project_doc_max_bytes` in `.codex/config.toml` tracks the route cap.
Skill
mirrors must match their canonical `.agents/skills` source except for documented
runtime-specific provenance literals, such as forensic-report writes using
`source: "Codex"` in the Codex skill and `source: "claude"` in the Claude skill.
