/**
 * Part of the quality gate's routing table. Read
 * `scripts/gate/routing-table/index.mjs` first: it owns the group order, the
 * schema, and the pairing lint, and it is the only module anything outside this
 * directory should import.
 *
 * ORDER IS ROUTING. Arms match first-to-last within a group, so an arm's index
 * is its precedence: move one and the gate schedules something else. Nothing
 * checks that. `routing-table.test.mjs` pins only the GROUP order, against a
 * written-out list.
 */

/**
 * The documentation and shell arms of the `tree` group, plus the two files that
 * reach no other `scripts/` arm.
 *
 * ADR 0064's pairing rule lives here, in the two `scripts/*.sh` groups: an arm
 * anchored on a literal prefix at the top of `scripts/` stops matching one
 * directory down, and nothing reds when it does. Every arm that carries the
 * any-depth sibling says so with `pairing: "paired"`, and the pairing lint in
 * `checks.mjs` refuses a table where one of them quietly loses it.
 */
export const SCRIPT_ARMS = [
  {
    patterns: [
      "docs/*",
      "README.md",
      "AGENTS.md",
      "*/AGENTS.md",
      "BACKLOG.md",
      "SPEC.md",
    ],
    effects: [
      { surface: "docs" },
      {
        dispatch: "path",
        arms: [
          {
            patterns: ["AGENTS.md", "*/AGENTS.md"],
            effects: [
              {
                command: "pnpm agent:context-check",
                reason: "agent context standards changed",
              },
              {
                why: "A scoped AGENTS.md reaching this route (not an earlier package route) is a brand-new standalone service (governance-watchdog-style) added without a pnpm-workspace.yaml change. The reminder self-suppresses on an edit to an existing AGENTS.md, so this only nags on a new one.",
                adrReminder:
                  "scoped AGENTS.md changed — ADR reminder (a new package/service likely needs an ADR)",
              },
            ],
          },
          {
            patterns: [
              "docs/context-standards.md",
              "docs/pr-checklists/recurring-review-patterns.md",
            ],
            effects: [
              {
                command: "pnpm agent:context-check",
                reason: "agent context standards changed",
              },
            ],
          },
          {
            patterns: ["docs/notes/sentry-triage-pipeline.md"],
            effects: [
              {
                why: "This note is the verdict contract, and the brief suite asserts the contract's needs-human fields are documented here (#1748) — a field renamed in code and not here is exactly the drift it catches.",
                command: "pnpm sentry:brief:test",
                reason: "Sentry verdict contract note changed",
              },
            ],
          },
          {
            patterns: ["SPEC.md"],
            effects: [
              {
                command: "pnpm agent:context-check",
                reason: "technical specification changed",
              },
            ],
          },
          {
            patterns: ["docs/*.md"],
            effects: [
              {
                why: "check-agent-context.mjs discovers canonical files across all of docs/**/*.md, so any docs markdown change may affect the frontmatter/staleness policy — route it through the check.",
                command: "pnpm agent:context-check",
                reason:
                  "docs markdown may be canonical (frontmatter discovery)",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: [
      ".agents/*",
      ".claude/skills/*",
      ".claude/settings.json",
      ".codex/hooks.json",
    ],
    effects: [
      { surface: "agent-context" },
      {
        command: "pnpm agent:context-check",
        reason: "agent context files changed",
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [".agents/skills/*", ".claude/skills/*"],
            effects: [
              {
                command:
                  "node scripts/repo-health/check-skills-mirror.test.mjs",
                reason: "skills mirror content changed",
              },
              {
                command: "node scripts/repo-health/check-skills-mirror.mjs",
                reason: "skills mirror content changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: ["scripts/*.sh"],
    effects: [
      { surface: "scripts" },
      {
        dispatch: "path",
        arms: [
          {
            why: "Exact live path first, the any-depth pair second. This arm sits FIRST in the case, so if the exact path ever goes stale again the widened arm below catches the file and the run keeps scheduling the root-anchor check while the runtime-log filter check quietly drops out. Partial routing reads as working routing, which is worse than the gap the pair exists to close — so the pair stays even though the glob alone would match the wrapper where it lives today.",
            patterns: [
              "scripts/deploy/deploy-indexer-logs.sh",
              "scripts/*/deploy-indexer-logs.sh",
            ],
            pairing: "paired",
            effects: [
              {
                command: "node scripts/check-deploy-root-anchors.test.mjs",
                reason: "deploy wrapper changed",
              },
              {
                command:
                  "node scripts/deploy/filter-envio-runtime-errors.test.mjs",
                reason: "indexer runtime-log filter changed",
              },
            ],
          },
          {
            why: "Paired one-level arm, the ADR 0064 remedy for a literal-prefix glob. `scripts/deploy-*.sh` is anchored on a prefix at the TOP of scripts/, so it stops matching the moment a wrapper sits one directory down — and nothing reds: the root-anchor check simply stops being scheduled. `*` matches `/` in a `case` pattern, so the paired arm reaches every depth. Shell-only on purpose: the subject set of check-deploy-root-anchors.test.mjs is `deploy-*.sh` files that source `lib/deploy-guard.sh`, and that walk is already recursive, so the check is ready for the move before the routing is.  That same breadth reaches a `deploy-*.sh` basename under any scripts/ subdirectory, today `scripts/lib/deploy-guard.sh` — deliberate, and pinned in the suite. Matching the check's own recursive walk is the whole point; a pattern stopping at one fixed directory would be narrower than what it schedules. The guard is the file every wrapper sources, so a change to it is exactly when the check should run. Consequence for later edits: `case` takes the FIRST matching arm, so a new arm for a path of the shape `scripts/<dir>/deploy-*.sh` belongs ABOVE this one or it never runs.",
            patterns: ["scripts/deploy-*.sh", "scripts/*/deploy-*.sh"],
            pairing: "paired",
            effects: [
              {
                command: "node scripts/check-deploy-root-anchors.test.mjs",
                reason: "deploy wrapper changed",
              },
            ],
          },
          {
            patterns: ["scripts/sanitize-terraform-output.sh"],
            effects: [
              {
                command: "pnpm sanitize:test",
                reason: "Terraform output sanitizer changed",
              },
            ],
          },
        ],
      },
      {
        dispatch: "path",
        arms: [
          {
            patterns: [
              "scripts/agent-quality-gate.sh",
              "scripts/agent-quality-gate.test.sh",
              "scripts/gate/run-handles.sh",
            ],
            effects: [
              {
                command: "pnpm agent:quality-gate:test",
                reason: "agent quality gate mapping changed",
              },
              {
                why: "routing-table.test.mjs reads this file: it asserts `implementation_signature()` lists every routing-table module and no module that is gone. A missing entry hashes as `__missing__` and FREEZES the freshness signature, so `--skip-if-fresh` reuses a stale stamp and skips real pre-push work — the ADR 0064 failure that reds nowhere else. The table's own arm covers a table-only edit; this covers the other direction, where somebody edits the gate's signature list and does not touch the table (ADR 0069).",
                command: "pnpm gate:routing-table:test",
                reason:
                  "gate holds the routing table's implementation-signature pin",
              },
            ],
          },
          {
            patterns: [
              "scripts/gate/quality-gate-coordinator.sh",
              "scripts/gate/quality-gate-coordinator-support.sh",
            ],
            effects: [
              {
                command: "pnpm agent:quality-gate:test",
                reason: "quality-gate coordinator changed",
              },
            ],
          },
          {
            patterns: [
              "scripts/agent-autoreview.sh",
              "scripts/agent-autoreview.test.sh",
            ],
            effects: [
              {
                command: "pnpm agent:autoreview:test",
                reason: "agent autoreview adapter changed",
              },
            ],
          },
          {
            patterns: [
              "scripts/repo-health/dev-janitor.sh",
              "scripts/repo-health/dev-janitor.test.sh",
            ],
            effects: [
              {
                command: "bash scripts/repo-health/dev-janitor.test.sh",
                reason: "dev janitor script changed",
              },
            ],
          },
          {
            why: 'Paired like the two arms in the case above. This is a separate `case` statement, so the widened deploy glob cannot shadow it — but an exact path stops matching after a move all the same, and these two commands are the whole Cloud Run half of this wrapper\'s routing. Pairing it here is what makes "a moved deploy script routes identically" true for the bridge rather than true for the root-anchor check alone.',
            patterns: [
              "scripts/deploy/deploy-bridge.sh",
              "scripts/*/deploy-bridge.sh",
            ],
            pairing: "paired",
            effects: [
              {
                checklist: "docs/pr-checklists/terraform-cloudrun.md",
                reason: "Cloud Run deploy script changed",
              },
              {
                command: "pnpm agent:context-check",
                reason: "Cloud Run revision suffix guard changed",
              },
            ],
          },
          {
            patterns: ["scripts/bootstrap/agent-session-end-hook.sh"],
            effects: [
              {
                command: "pnpm agent:context-check",
                reason: "agent SessionEnd hook changed",
              },
            ],
          },
          {
            patterns: [
              "scripts/bootstrap/codex-cloud-setup.sh",
              "scripts/bootstrap/codex-cloud-setup.test.sh",
            ],
            effects: [
              {
                command: "bash scripts/bootstrap/codex-cloud-setup.test.sh",
                reason: "Codex Cloud Foundry installer contract changed",
              },
            ],
          },
          {
            patterns: ["scripts/lib/install-marker.sh"],
            effects: [
              {
                why: "Sourced by scripts/setup.sh and scripts/bootstrap/claude-code-web-setup.sh. `bash -n` cannot see the skip semantics, so route the suite that exercises them.",
                command: "pnpm agent:quality-gate:test",
                reason: "shared install-marker fragment changed",
              },
            ],
          },
          {
            patterns: [
              "scripts/setup.sh",
              "scripts/bootstrap/claude-code-web-setup.sh",
            ],
            effects: [
              {
                why: "The two install-marker consumers. The suite pins that both still source the shared fragment and use its hash, which `bash -n` cannot see, and re-runs the fragment's own behavioral checks.",
                command: "pnpm agent:quality-gate:test",
                reason: "install-marker consumer changed",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    patterns: [".coderabbit.yaml"],
    effects: [
      {
        why: "CodeRabbit resolves this config from the PR's SOURCE branch, and its findings feed the pr:feedback-state ledger, so the config is a trust boundary (ADR 0066). A repo-root .yaml reaches no `scripts/*` arm, so claim the surface and route the allowlist pin here.",
        surface: "scripts",
      },
      {
        command: "pnpm coderabbit:config:test",
        reason: "CodeRabbit review config changed",
      },
    ],
  },
  {
    patterns: ["scripts/sentry/gate/sentry-suite-manifest.json"],
    effects: [
      {
        why: "The manifest the self-run Sentry-suite gate reconciles against (#1779, ADR 0062). A .json edit reaches no other scripts/ arm, so claim the surface here; the repo-specific block below routes the two gate commands for this file along with every manifest-owned suite.",
        surface: "scripts",
      },
    ],
  },
  {
    patterns: ["scripts/repo-health/guardrail-prose.json"],
    effects: [
      {
        why: "The pin list check-guardrail-prose.mjs reads. Like the Sentry manifest above, a .json under scripts/ reaches no module arm — those key off `.mjs` — and would otherwise fall through to the bare `scripts/*` catch-all with no commands at all. Editing a pin IS the deliberate rule change this check exists to surface, so it has to run the checker against the edited list.",
        surface: "scripts",
      },
      {
        command: "node scripts/repo-health/check-guardrail-prose.test.mjs",
        reason: "guardrail prose pin list changed",
      },
      {
        command: "node scripts/repo-health/check-guardrail-prose.mjs",
        reason: "guardrail prose pin list changed",
      },
    ],
  },
];
