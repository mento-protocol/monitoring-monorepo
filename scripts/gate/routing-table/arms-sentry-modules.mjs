/**
 * Part of the quality gate's routing table. Read
 * `scripts/gate/routing-table/index.mjs` first: it owns the group order, the
 * schema, and the pairing lint, and it is the only module anything outside this
 * directory should import.
 *
 * ORDER IS ROUTING. Arms are first-match within their group, so an arm's index
 * IS its precedence — moving one up or down changes what the gate schedules,
 * and nothing about the diff will tell you that. The group order this file's
 * arms land in is asserted by `routing-table.test.mjs` against a written-out
 * list, for the same reason.
 */

/**
 * The Sentry leg of the per-module dispatch under `scripts/*.mjs`: triage,
 * autofix, the archive and requeue passes, and the MCP broker.
 *
 * Several arms schedule more than one suite on purpose. The legs share their
 * field selection and their marker contracts, so a change to one module can
 * break a consumer whose own suite would never run otherwise; the `why` on each
 * arm records which consumer and why.
 */
export const SENTRY_MODULE_ARMS = [
  {
    patterns: ["scripts/sentry/fixture-scan-canary.test.mjs"],
    effects: [
      {
        why: "The #1943/#1970 drift canary (ADR 0068). Its own arm, ABOVE the per-suite arms below, because those arms name exact paths and a combined pattern here would shadow them — the routing bug #1974 shipped. The canary's watch list is a path pin: a renamed suite has to move here too, and this route is what makes that loud.",
        command: "node scripts/sentry/fixture-scan-canary.test.mjs",
        reason: "Sentry fixture drift canary changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/triage/sentry-triage-ingest.mjs",
      "scripts/sentry/triage/sentry-triage-ingest.test.mjs",
    ],
    effects: [
      {
        command: "pnpm sentry:ingest:test",
        reason: "Sentry triage ingest helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/triage/sentry-triage-digest.mjs",
      "scripts/sentry/triage/sentry-triage-digest-render.mjs",
      "scripts/sentry/triage/sentry-triage-digest.test.mjs",
    ],
    effects: [
      {
        why: "digest-render.mjs is the pure Slack-render + section-taxonomy layer split out of digest.mjs (#1812); the digest suite covers both, so a render-only change must still run the snapshot / Slack-safety tests.",
        command: "pnpm sentry:digest:test",
        reason: "Sentry triage digest helper changed",
      },
      {
        why: "The two needs-human brief emitters share their field selection and bounds; the queue-issue one also reads the digest's autofix prefix.",
        command: "pnpm sentry:brief:test",
        reason: "Sentry triage digest helper changed",
      },
      {
        why: "The digest owns LABEL_TO_VERDICT, one of the three verdict-label maps the projection suite pins against each other.",
        command: "pnpm sentry:project:test",
        reason: "Sentry triage digest helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/triage/sentry-triage-brief.mjs",
      "scripts/sentry/triage/sentry-triage-brief-render.mjs",
      "scripts/sentry/triage/sentry-triage-brief.test.mjs",
    ],
    effects: [
      {
        command: "pnpm sentry:brief:test",
        reason: "Sentry needs-human brief helper changed",
      },
      {
        why: "Sibling emitter over the same shared selection.",
        command: "pnpm sentry:digest:test",
        reason: "Sentry needs-human brief helper changed",
      },
      {
        why: "The brief leg is a shared dependency of the two other legs that call into it, so a brief export or clearing-semantics change must run BOTH their focused suites: the archive leg clears the brief on settlement (settleQueueStub -> clearBriefComments), and the projection leg clears a stale brief before it closes the stub (runProjectionBatch -> clearBriefComments). Without the projection suite here a brief change can break that close guard without running its consumer test.",
        command: "pnpm sentry:archive:test",
        reason: "Sentry needs-human brief helper changed",
      },
      {
        command: "pnpm sentry:project:test",
        reason: "Sentry needs-human brief helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/triage/sentry-triage-project.mjs",
      "scripts/sentry/triage/sentry-triage-project-core.mjs",
      "scripts/sentry/triage/sentry-triage-project-route.mjs",
      "scripts/sentry/triage/sentry-triage-project-cli.mjs",
      "scripts/sentry/triage/sentry-triage-label-ensure.mjs",
      "scripts/sentry/triage/sentry-triage-project.test.mjs",
      "scripts/sentry/triage/sentry-triage-text.mjs",
      "scripts/sentry/triage/sentry-triage-projection.mjs",
      "scripts/sentry/triage/sentry-triage-escalation-contract.mjs",
    ],
    effects: [
      {
        why: "sentry-triage-project-cli.mjs (the argv surface) and sentry-triage-label-ensure.mjs (the settlement label self-heal) were split out of the entry module for the 1,000-line cap (#1827); both are covered by the projection suite and reached only through it, so they route exactly like the file they came from.",
        command: "pnpm sentry:project:test",
        reason: "Sentry triage projection helper changed",
      },
      {
        why: "The agent's comment wrapper imports the shared marker contract from sentry-triage-project-core.mjs, so its fences ride on this module.",
        command:
          "node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs",
        reason: "Sentry triage projection helper changed",
      },
      {
        why: "The verdict parser and the shared brief selection live here; both brief emitters are pure consumers of them.",
        command: "pnpm sentry:brief:test",
        reason: "Sentry triage projection helper changed",
      },
      {
        command: "pnpm sentry:digest:test",
        reason: "Sentry triage projection helper changed",
      },
      {
        why: "The archive leg imports the marker + trusted-author contract from this module (ARCHIVE_COMMENT_MARKER, isTrustedComment), so a change here can break its audit-comment idempotency and brief-clear (#1769 round 15).",
        command: "pnpm sentry:archive:test",
        reason: "Sentry triage projection helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/triage/sentry-triage-agent-comment.mjs",
      "scripts/sentry/triage/sentry-triage-agent-comment.test.mjs",
      "scripts/sentry/triage/sentry-triage-broker-guard.mjs",
    ],
    effects: [
      {
        command:
          "node scripts/sentry/triage/sentry-triage-agent-comment.test.mjs",
        reason: "Sentry triage agent comment wrapper changed",
      },
      {
        command: "node scripts/sentry/fixture-scan-canary.test.mjs",
        reason: "Sentry suite carrying scanned fixtures changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/autofix/sentry-autofix-select.mjs",
      "scripts/sentry/autofix/sentry-autofix-select.test.mjs",
    ],
    effects: [
      {
        command: "pnpm sentry:autofix:select:test",
        reason: "Sentry autofix select helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/autofix/sentry-autofix-select-cli.mjs",
      "scripts/sentry/autofix/sentry-autofix-decisions.mjs",
    ],
    effects: [
      {
        why: "The selector's CLI surface (option contract, help text, the report files the tracker reads back, --emit-verdict) and the decision -> report classifier both passes share. Neither owns a cost cap; both are exercised end to end by the select suite, which drives the CLI layer through writeRunReports and the classifier through the family collapse.",
        command: "pnpm sentry:autofix:select:test",
        reason: "Sentry autofix selection helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/autofix/sentry-autofix-select-instrument.mjs",
      "scripts/sentry/autofix/sentry-autofix-second-look.mjs",
    ],
    effects: [
      {
        why: "The selector's budget + instrumentation layer (the per-run read cap and its no-op guard, the gh counter, the throttle latch, the DEGRADED and summary lines) and the bounded second look.",
        command: "pnpm sentry:autofix:select:test",
        reason: "Sentry autofix selection helper changed",
      },
      {
        why: "These two OWN caps the finalize suite pins the select job's timeout-minutes against — MAX_CANDIDATE_EVALUATIONS here, MAX_SECOND_LOOK_EVALUATIONS + SECOND_LOOK_FAMILY_BUDGETS there. That pin derives the budget from the LIVE constants, so raising one without re-checking the timeout has to fail in the gate, not in production on the path the second look exists to create.",
        command: "pnpm sentry:autofix:finalize:test",
        reason: "Sentry autofix per-run cost cap changed",
      },
    ],
  },
  {
    patterns: ["scripts/sentry/autofix/sentry-autofix-family-handled.mjs"],
    effects: [
      {
        why: "The handled-FAMILY lookup, split out of sentry-autofix-queue-io.mjs for the 600-line soft cap. Its behaviour is exercised end to end by the select suite, like every other module on this leg.",
        command: "pnpm sentry:autofix:select:test",
        reason: "Sentry autofix handled-family lookup changed",
      },
      {
        why: "It also OWNS a cap the finalize suite pins the select job's timeout-minutes against — MAX_HANDLED_ID_QUERIES, one of the terms in that suite's worst-case serial `gh` call count. Same reason sentry-autofix-select-instrument.mjs routes there: raising the cap without re-checking the timeout has to fail in the gate, not in production.",
        command: "pnpm sentry:autofix:finalize:test",
        reason: "Sentry autofix per-run cost cap changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/autofix/sentry-autofix-queue-io.mjs",
      "scripts/sentry/autofix/sentry-autofix-family-resolve.mjs",
      "scripts/sentry/autofix/sentry-autofix-reverse-verify.mjs",
      "scripts/sentry/autofix/sentry-autofix-family.mjs",
      "scripts/sentry/autofix/sentry-autofix-candidate.mjs",
    ],
    effects: [
      {
        why: "The selection leg's gh I/O layer (the window list, readStub, openAutofixPrExists / isOwnHeadPr), the live-state family resolver, the reverse `in:comments` verification leg, and the pure union-find family module (transitive union / project scoping / MAX_FAMILY_MEMBERS / representative rule) — all consumed by the selector. Each is exercised by the select suite, which mocks runGh and drives the full flow end to end.",
        command: "pnpm sentry:autofix:select:test",
        reason: "Sentry autofix selection helper changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/autofix/sentry-autofix-finalize.mjs",
      "scripts/sentry/autofix/sentry-autofix-finalize.test.mjs",
    ],
    effects: [
      {
        command: "pnpm sentry:autofix:finalize:test",
        reason: "Sentry autofix finalize helper changed",
      },
      {
        command: "node scripts/sentry/fixture-scan-canary.test.mjs",
        reason: "Sentry suite carrying scanned fixtures changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/autofix/sentry-autofix-run-record.mjs",
      "scripts/sentry/autofix/sentry-autofix-run-record.test.mjs",
      "scripts/sentry/autofix/sentry-autofix-refused-inventory.mjs",
    ],
    effects: [
      {
        why: "The tracker run-record body builder, extracted from finalize.mjs, and its bounded refused-stub Search API helper. Run the focused suite AND finalize's — finalize imports the builder for the `run-record` CLI subcommand, so their wiring rides on this route.",
        command: "pnpm sentry:autofix:run-record:test",
        reason: "Sentry autofix run-record builder changed",
      },
      {
        command: "pnpm sentry:autofix:finalize:test",
        reason: "Sentry autofix run-record builder changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/autofix/sentry-autofix-record-labels.mjs",
      "scripts/sentry/autofix/sentry-autofix-hold-revalidate.mjs",
    ],
    effects: [
      {
        why: "The record-run architectural backfill labeler (#1812) and the revalidation/compensation layer extracted from it. Their tests live in the finalize suite (the record-run job that owns this write), which exercises the plan, the pre/post live-scope checks, the label writes and the withdrawal + terminal-guarded re-queue.",
        command: "pnpm sentry:autofix:finalize:test",
        reason: "Sentry autofix record-run backfill labeler changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/triage/sentry-triage-archive.mjs",
      "scripts/sentry/triage/sentry-triage-archive.test.mjs",
    ],
    effects: [
      {
        command: "pnpm sentry:archive:test",
        reason: "Sentry triage archive helper changed",
      },
      {
        command: "node scripts/sentry/fixture-scan-canary.test.mjs",
        reason: "Sentry suite carrying scanned fixtures changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/broker/sentry-mcp-broker.mjs",
      "scripts/sentry/broker/sentry-mcp-broker.test.mjs",
      "scripts/sentry/broker/sentry-mcp-probe.mjs",
    ],
    effects: [
      {
        why: "The broker and the MCP pre-flight probe (#1938) share one suite: sentry-mcp-broker.test.mjs holds both, so the probe must route here too or a change touching only the probe runs none of its own tests.",
        command: "pnpm sentry:broker:test",
        reason: "Sentry MCP broker or pre-flight probe changed",
      },
      {
        command: "node scripts/sentry/fixture-scan-canary.test.mjs",
        reason: "Sentry suite carrying scanned fixtures changed",
      },
    ],
  },
  {
    patterns: [
      "scripts/sentry/triage/sentry-triage-requeue.mjs",
      "scripts/sentry/triage/sentry-triage-requeue.test.mjs",
      "scripts/sentry/triage/sentry-triage-requeue-sentinel.mjs",
      "scripts/sentry/triage/sentry-triage-queue-contract.mjs",
      "scripts/sentry/triage/sentry-triage-workflow-requeue.mjs",
    ],
    effects: [
      {
        why: "The single re-queue chokepoint, the queue contract it reads, and the workflow CLI that wraps it for every compensating exit in the triage agent workflow (#1769 round 17, #1782). Every site that re-queues a stub runs through the chokepoint, so its suite is never the whole story — run theirs too. The CLI's tests live in the requeue suite.",
        command: "pnpm sentry:requeue:test",
        reason: "Sentry re-queue chokepoint changed",
      },
      {
        command: "pnpm sentry:ingest:test",
        reason: "Sentry re-queue chokepoint changed",
      },
      {
        command: "pnpm sentry:archive:test",
        reason: "Sentry re-queue chokepoint changed",
      },
      {
        why: "The brief leg maintains a dedicated COMMENT on the stub (the archive leg is the SOLE body writer, #1766). Its suite is routed here because a queue-contract change can shift the re-queue lifecycle the brief and archive legs both observe.",
        command: "pnpm sentry:brief:test",
        reason: "Sentry re-queue chokepoint changed",
      },
      {
        why: "The contract owns VERDICT_LABELS, which the verdict step's shed is derived from and the projection suite pins against the other two verdict-label maps.",
        command: "pnpm sentry:project:test",
        reason: "Sentry re-queue chokepoint changed",
      },
    ],
  },
];
