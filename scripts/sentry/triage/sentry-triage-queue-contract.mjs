/**
 * Pure queue contract for the Sentry triage pipeline (ADR 0036): the label
 * namespace, the untrusted-text neutralization every public-repo write goes
 * through, and the archive freshness-baseline field pair. NO I/O lives here.
 *
 * Why this module exists rather than more arrivals in
 * `sentry-triage-project-core.mjs`: that module is the VERDICT contract (markers,
 * parsing, comment selection) and is already the largest shared surface in this
 * package. The queue-label and archive-baseline contracts are a different thing
 * with different consumers, and they are what `sentry-triage-requeue.mjs` — the
 * single re-queue chokepoint — needs. Giving them their own home is what lets the
 * chokepoint live outside `sentry-triage-ingest.mjs` without an import cycle
 * (ingest imports the chokepoint; the chokepoint would otherwise import ingest).
 *
 * `sentry-triage-ingest.mjs` re-exports everything here, so the queue scripts and
 * their tests keep one import surface.
 */

import { extractYamlBlock } from "./sentry-triage-project-core.mjs";

// ---------------------------------------------------------------------------
// Untrusted-text neutralization. Sentry titles/culprits/timestamps are
// attacker-reachable text — never execute/eval anything derived from them, and
// never let them reach a public queue issue unneutralized.
// ---------------------------------------------------------------------------

/** Strip control chars/newlines and collapse whitespace to a single line. */
export function sanitizeFreeText(text) {
  return (
    String(text ?? "")
      // eslint-disable-next-line no-control-regex -- stripping control chars from untrusted Sentry text is the whole point here
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Replace every backtick with a visually similar but byte-distinct
// character. This is what actually prevents an attacker-controlled Sentry
// title/culprit from closing the ```yaml fence early (or a single-backtick
// inline-code span) once embedded in the issue body's markdown.
export function defangBackticks(text) {
  return text.replace(/`/g, "ˋ");
}

// Insert a zero-width space after every `@` so `@user` / `@org/team` in
// attacker-reachable Sentry text can never become a live GitHub mention
// (which would notify/subscribe real users) once embedded in an issue title
// or comment. Visual fidelity is preserved for triage.
export function defangMentions(text) {
  return text.replace(/@/g, "@\u200B");
}

export function neutralizeUntrusted(text) {
  return defangMentions(defangBackticks(sanitizeFreeText(text)));
}

export function truncateTitle(text, maxLen = 90) {
  const clean = text ?? "";
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Label namespace.
// ---------------------------------------------------------------------------

// The queue's "awaiting a current verdict" marker. Stage B's selector filters
// on it, the digest classifies on it, and the re-queue chokepoint writes it —
// so it is a named constant here rather than a literal at each use site. The
// LABEL_DEFINITIONS entry keeps its own literal on purpose (the bootstrap must
// list every label inline).
export const NEEDS_TRIAGE_LABEL = "sentry:needs-triage";

// DURABLE QUEUE MEMBERSHIP. Stage B's selector requires this label AND
// `sentry:needs-triage`, so a stub without it is invisible to triage no matter
// what else it carries — which makes removing it the strongest withdrawal
// gesture this namespace has, and the only one available for a stub that has no
// `sentry:needs-triage` left to remove. Anything that re-enrolls a stub must
// therefore check it against LIVE state first. `scripts/sentry/autofix/sentry-autofix-queue-io.mjs`
// keeps its own `SENTRY_TRIAGE_QUEUE_LABEL` twin for its search strings, and the
// LABEL_DEFINITIONS entry below keeps its literal because the bootstrap must
// list every label inline.
export const QUEUE_LABEL = "sentry-triage";

// Idempotently created/updated on every run (`gh label create --force`).
export const LABEL_DEFINITIONS = [
  {
    name: "sentry-triage",
    color: "5319e7",
    description: "Sentry triage pipeline queue issue (ADR 0036)",
  },
  {
    name: "sentry:needs-triage",
    color: "fbca04",
    description: "Awaiting triage-agent verdict",
  },
  {
    name: "sentry:candidate-noise",
    color: "d4c5f9",
    description:
      "Matches known operational-noise heuristics (CSP, timeouts, chunk-load, abort)",
  },
  {
    name: "sentry:verdict-code-fix",
    color: "0e8a16",
    description: "Triage verdict: fixable in this repo's code",
  },
  {
    name: "sentry:verdict-config-fix",
    color: "1d76db",
    description: "Triage verdict: fixable via configuration",
  },
  {
    name: "sentry:verdict-upstream",
    color: "e99695",
    description: "Triage verdict: upstream/third-party, not fixable here",
  },
  {
    name: "sentry:verdict-needs-human",
    color: "d93f0b",
    description: "Triage verdict: needs human judgment",
  },
  {
    name: "sentry:projected",
    color: "0052cc",
    description:
      "Actionable verdict projected as an issue in the owning repo (ADR 0038)",
  },
  {
    name: "sentry:fix-pr-opened",
    color: "006b75",
    description:
      "Autofix leg opened a scoped fix PR for this verdict (ADR 0036 Phase 2b)",
  },
  {
    name: "sentry:fix-refused",
    color: "bfdadc",
    description:
      "Autofix declined to open a PR (no change/guard-refused); remove to retry (ADR 0036 Phase 2b)",
  },
  {
    name: "sentry:fix-scope-architectural",
    color: "a371f7",
    description:
      "Local code-fix, fix_scope architectural — open human design work; autofix never selects it (#1812)",
  },
  {
    name: "sentry:approved-archive",
    color: "1a7f37",
    description:
      "Human-approved: archive the underlying Sentry issue (Phase 2a, ADR 0036)",
  },
  {
    name: "sentry:archived",
    color: "6e7681",
    description:
      "Sentry issue archived (archived_until_escalating) via the Phase 2a archive loop (ADR 0036)",
  },
];

export const PROJECTED_LABEL = "sentry:projected";

// The verdict that makes a queue stub eligible for the autofix leg. The autofix
// finalize step re-reads this immediately before writing a terminal marker: the
// diff is only justified while the verdict that produced it still stands, and
// ingest (its own concurrency group) can shed it mid-run on a regression
// re-queue. Single source of truth for the JS consumers — the select step
// imports it as AUTOFIX_SELECT_LABEL and the finalize marker re-read imports it
// as its expected verdict. The LABEL_DEFINITIONS entry above and the workflow's
// pre-push grep guard (.github/workflows/sentry-autofix.yml) are deliberate
// literal twins: the label bootstrap must list every label inline, and a shell
// `grep -Fxq` cannot import a JS constant.
export const CODE_FIX_VERDICT_LABEL = "sentry:verdict-code-fix";

// Applied to a `code-fix` queue stub once the autofix leg (ADR 0036 Phase 2b,
// `.github/workflows/sentry-autofix.yml`) has opened a scoped fix PR for it.
// The autofix select step reads it as a dedup marker so a stub is never
// re-fixed. Bootstrapped from LABEL_DEFINITIONS above (single source of truth)
// and self-healed by the autofix finalize step before it labels the stub.
export const FIX_PR_OPENED_LABEL = "sentry:fix-pr-opened";

// Applied to a `code-fix` queue stub when an autofix attempt declined to open a
// PR — the agent made no change or the mechanical diff guard refused the diff.
// Without it the same unfixable stub is re-picked every run and burns the
// per-run cap forever (starvation). The autofix select step reads it as a dedup
// marker exactly like FIX_PR_OPENED_LABEL; a human clears it (removes the label)
// to allow a fresh retry. Bootstrapped from LABEL_DEFINITIONS above and
// self-healed by the autofix workflow's refused path before it labels the stub.
export const FIX_REFUSED_LABEL = "sentry:fix-refused";

// A `code-fix` verdict whose `fix_scope` is `architectural` (issue #1785/#1812):
// the cause is in this repo's code, but the fix is open human design work, not a
// mechanical diff an agent can safely author. The settlement step
// (.github/workflows/sentry-triage-agent.yml) rides this label onto the SAME
// atomic `gh issue edit` as the verdict label and leaves the stub OPEN; the
// autofix select step (`listCodeFixStubs`) excludes it at query time so the
// architectural backlog never fills the candidate window (issue #1813). It
// conveys exactly one state — this stub's CURRENT verdict is local code-fix,
// fix_scope architectural — and is NEVER terminal: it is shed on regression and
// on any re-verdict (REOPEN_SHED_LABELS below), never read by the terminal-ledger
// lookups, and human-removable. It sits OUTSIDE the `sentry:verdict-*` namespace
// on purpose, so the settlement post-condition still counts exactly one verdict
// label (VERDICT_LABELS filters on the `sentry:verdict-` prefix). Bootstrapped
// from LABEL_DEFINITIONS above and self-healed by the autofix record-run backfill
// before it labels a legacy stub. Removing this label is NOT the operator
// affordance — the verdict re-parse still refuses and the record-run re-applies
// it; re-triage via workflow_dispatch is.
export const FIX_SCOPE_ARCHITECTURAL_LABEL = "sentry:fix-scope-architectural";

// Phase 2a human-approved archive loop (ADR 0036 Stage C,
// scripts/sentry/triage/sentry-triage-archive.mjs + .github/workflows/sentry-triage-archive.yml).
// APPROVED_ARCHIVE_LABEL is the human-applied approval marker that triggers the
// archive workflow; ARCHIVED_LABEL is the terminal audit marker the archive
// script applies once the Sentry issue is archived. Both are bootstrapped by
// the ingest label set above and self-healed by the archive script — single
// source of truth for their colors/descriptions.
export const APPROVED_ARCHIVE_LABEL = "sentry:approved-archive";
export const ARCHIVED_LABEL = "sentry:archived";

// Stage B's verdict namespace, derived from the definitions above so the two
// can't drift. A reopened regression must shed its previous verdict — the
// old verdict described the old occurrence, and downstream consumers filter
// on `sentry:needs-triage` + absence of a verdict.
export const VERDICT_LABELS = LABEL_DEFINITIONS.map(
  (label) => label.name,
).filter((name) => name.startsWith("sentry:verdict-"));

// The one verdict whose stub RESTS open. `.github/workflows/sentry-triage-agent.yml`
// closes every other bucket in its close step; `needs-human` exits that step
// early and leaves the stub open for a human to answer. So open +
// `sentry:verdict-needs-human` + no `sentry:needs-triage` is a resting state,
// not a strand, and anything sweeping the open-but-unselectable shape must skip
// it — re-queuing it would strip the question a human was asked and re-triage
// the stub on a loop.
export const NEEDS_HUMAN_VERDICT_LABEL = "sentry:verdict-needs-human";

// The verdicts whose stub is SUPPOSED to end up closed. A stub still open on one
// of these, with no `sentry:needs-triage`, has a round that never settled it —
// the shape ingest's stranded sweep repairs (issue #1817).
export const SETTLING_VERDICT_LABELS = VERDICT_LABELS.filter(
  (name) => name !== NEEDS_HUMAN_VERDICT_LABEL,
);

// The two unselectable shapes ingest's stranded sweep repairs. The PREDICATES
// live with the sweep (`strandedShapeOf` in scripts/sentry/triage/sentry-triage-ingest.mjs);
// the names live here because the re-queue chokepoint renders a note per shape
// and must not import ingest — ingest imports it.
export const STRAND_SHAPE_CLOSED_NEEDS_TRIAGE = "closed-needs-triage";
export const STRAND_SHAPE_OPEN_VERDICT = "open-verdict";

// Labels a re-queue must shed: the stale verdict labels, the stale
// `sentry:projected` marker (ADR 0038), the stale autofix markers
// (`sentry:fix-pr-opened` / `sentry:fix-refused`, ADR 0036 Phase 2b), AND the
// stale Phase-2a archive markers (`sentry:approved-archive` / `sentry:archived`).
// A re-queue means the stub is awaiting a fresh verdict, so every trace of how
// the previous round was handled must clear: leaving a verdict/projection would
// misrepresent a needs-triage stub as already verdicted/projected; leaving an
// autofix marker would both misrepresent it as fixed/refused AND block the
// re-triage round from ever being autofixed again (the select step dedups on
// those markers); and leaving an archive marker would misrepresent it as
// approved/archived — shedding the approval marker is also an authority-boundary
// guard, since a regression must not carry a stale human archive approval into a
// fresh occurrence (a workflow_dispatch retry would otherwise read it as
// still-approved and re-archive without re-review). If the re-triage round lands
// on an actionable verdict again, the projection/autofix steps re-apply their
// markers (idempotently reusing the same owning-repo issue / opening a fresh fix
// PR), and a fresh archive needs a fresh human approval.
export const REOPEN_SHED_LABELS = [
  ...VERDICT_LABELS,
  PROJECTED_LABEL,
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  // The architectural hold marks the CURRENT verdict's scope; a regression means
  // a fresh occurrence that must be re-triaged from scratch, so the fresh round
  // re-decides scope. Shedding it here is also what makes live-recompute the sole
  // authority for family stand-down (a durable sibling label would strand the
  // family when the blocker re-verdicts — see the deferred-family note in the
  // pipeline doc). Removing an absent label is a no-op, so a non-architectural
  // stub pays nothing for this entry.
  FIX_SCOPE_ARCHITECTURAL_LABEL,
  APPROVED_ARCHIVE_LABEL,
  ARCHIVED_LABEL,
];

// Shed markers a re-queue may never put BACK, even when unwinding its own shed
// against a stub that settled underneath it (ADR 0070). `sentry:approved-archive`
// is a spent human authority, and re-adding it is doubly wrong: a later
// workflow_dispatch would read it as still-approved and archive without
// re-review, and the add itself re-fires `sentry-triage-archive.yml`'s
// `issues: labeled` trigger. Restoring a verdict or a projection/autofix marker
// only restores a machine record; restoring this one hands out authority.
export const NEVER_RESTORED_LABELS = [APPROVED_ARCHIVE_LABEL];

// The needs-human brief (issue #1748) is NOT here, and no longer touches this
// body. It lives as a dedicated, updated-in-place COMMENT on the stub, its
// marker and lifecycle owned by scripts/sentry/triage/sentry-triage-brief.mjs. Rendering it
// into the body made it a second writer of a surface the archive leg owns, and
// no label check could keep the two apart through the archive's unlabeled
// settlement window (PR #1769). A comment races nothing: the archive stays the
// SOLE stub-body writer (see the trust-boundary note below), and stale-brief
// removal is deleting that comment, independent of any label.

// ---------------------------------------------------------------------------
// Archive freshness baseline (issue #1371).
// ---------------------------------------------------------------------------

// The archive script records the Sentry `lastSeen` it observed immediately
// BEFORE it mutated the issue, plus the Sentry issue id it mutated.
// `decideDedupAction` compares a regression's `lastSeen` against that instant
// instead of the stub's `closedAt`: the close necessarily postdates any event
// that landed while the archive ran, so a `closedAt` comparison would evaluate
// false for that event permanently and bury a real regression until some later
// event happened to arrive. These field names are the shared contract between
// scripts/sentry/triage/sentry-triage-ingest.mjs and scripts/sentry/triage/sentry-triage-archive.mjs.
//
// The baseline lives in the queue stub's BODY, in the same yaml block ingest
// writes at creation — never in a comment. That placement IS the trust boundary,
// and it is structural rather than cryptographic. The Stage B triage agent is an
// LLM reading attacker-controlled Sentry payloads, and
// .github/workflows/sentry-triage-agent.yml grants it
// `Bash(gh issue comment <matrix.issue>:*)` — its comments post as
// `github-actions[bot]`, on this exact stub. So no author check, marker check, or
// id check applied to a COMMENT can be trusted: a prompt-injected payload can
// satisfy all of them and plant a far-future baseline, after which every later
// regression of that Sentry issue is skipped indefinitely. The agent's allowlist
// grants no tool that edits an issue body (`Read,Grep,Glob` + three scoped
// `gh issue` subcommands; the autofix agent gets file-edit tools and no shell at
// all), and the ONLY step that rewrites a stub body is a deterministic, zero-LLM
// one running on a trusted runner: the archive leg's baseline write. It is the
// single stub-body writer (PR #1766) — the needs-human brief renders as a
// COMMENT, not into this body (#1748/#1769), so it adds no second writer to
// race here. Moving the field into the body therefore removes the forgery
// surface instead of trying to authenticate inside it, which a shared-secret
// signature could only match, never beat.
export const ARCHIVE_BASELINE_FIELD = "archive_baseline_last_seen";
export const ARCHIVE_BASELINE_ID_FIELD = "archive_baseline_sentry_issue_id";

// The SECOND baseline, and the one ingest's reopen gate actually compares
// against (issue #1692). `ARCHIVE_BASELINE_FIELD` above is read from Sentry
// AFTER the human applied `sentry:approved-archive`, so an event landing between
// the approval and that read is folded into the value meant to detect it: ingest
// asks `lastSeen > baseline`, which is false for the event that produced the
// baseline. The archive's own consumers still need that live read — it is the
// only thing the post-PUT mutation-window check and the already-archived retry
// refusals can compare against — so the fix is a second field rather than a
// different value in the first.
//
// This one carries an instant that provably PREDATES the approval: the stub
// body's own `last_seen`, written by ingest when it CREATED the stub and never
// rewritten — a reopen edits labels, comments and state, never the body, which
// is the same property that keeps the archive leg the only stub-body writer
// (see the trust-boundary note above). So on a stub that has regressed and
// reopened since, this is still the creation instant and can be as old as the
// stub itself — which only makes reopens more eager, and that is the intended
// bias (a spurious reopen costs one triage cycle, a buried regression costs an
// incident).
//
// A stub archived before this field existed carries only the first one, so
// `reopenBaselineOf` falls back to it and those stubs behave exactly as they did.
export const ARCHIVE_REOPEN_BASELINE_FIELD =
  "archive_reopen_baseline_last_seen";

/** Read one scalar out of a stub's yaml block. Keys are fixed literals (no regex
 * injection) written one per line as `key: "value"`. */
function readBaselineField(block, key) {
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(
    String(block ?? ""),
  );
  if (!match) return "";
  return match[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Parse the archive freshness baseline out of a queue stub's BODY. Returns null
 * when the body carries no baseline field — the normal state for a stub that has
 * never been archived. The timestamp comes back RAW; validity is the caller's
 * `Date.parse` gate, so a garbage value degrades to the `closedAt` fallback
 * instead of throwing.
 *
 * `reopenLastSeen` is the RAW second field and is `""` when the body does not
 * carry one. Faithfulness matters here: the archive's rollback reads a baseline
 * back out and writes it onto the live body, so inventing a value a pre-#1692
 * stub never had would make the rollback rewrite fields it is meant to restore.
 * Consumers that want the resolved value ask `reopenBaselineOf`.
 */
export function parseArchiveBaseline(issueBody) {
  const block = extractYamlBlock(issueBody);
  if (!block) return null;
  const lastSeen = readBaselineField(block, ARCHIVE_BASELINE_FIELD);
  if (!lastSeen) return null;
  return {
    lastSeen,
    sentryIssueId: readBaselineField(block, ARCHIVE_BASELINE_ID_FIELD),
    reopenLastSeen: readBaselineField(block, ARCHIVE_REOPEN_BASELINE_FIELD),
  };
}

/**
 * The instant ingest's reopen gate compares a regression's `lastSeen` against:
 * the pre-approval baseline when the stub carries one, else the archive-time
 * read (issue #1692). One accessor so no consumer has to remember the fallback,
 * and so a stub archived before the second field existed keeps its old
 * behaviour rather than losing its baseline entirely.
 */
export function reopenBaselineOf(baseline) {
  if (!baseline) return null;
  return baseline.reopenLastSeen || baseline.lastSeen || null;
}

/**
 * Return `body` with the archive baseline fields set inside its existing yaml
 * block, replacing any previous values (a re-archive supersedes). Used by the
 * archive leg's body rewrite; kept here so the writer and the reader above stay
 * one edit apart.
 *
 * A NULL baseline strips the two fields instead of setting them. The archive's
 * rollback needs that: it must put the baseline back the way it found it while
 * leaving every other part of the body — including edits a human made after the
 * run's snapshot — exactly as it is live.
 *
 * Returns null when the body has no yaml block to extend — the archive treats
 * that as a hard refusal rather than inventing structure, since a stub whose
 * body it cannot parse is one ingest cannot read a baseline back out of either.
 *
 * `baseline.reopenLastSeen` renders only when it is set, which is what keeps
 * this an exact inverse of `parseArchiveBaseline`: feeding a parsed pre-#1692
 * baseline straight back writes the same two fields it came from.
 */
export function withArchiveBaseline(body, baseline) {
  const source = String(body ?? "");
  const block = extractYamlBlock(source);
  if (!block) return null;
  const stripped = block
    .split("\n")
    .filter(
      (line) =>
        !new RegExp(
          `^(${ARCHIVE_BASELINE_FIELD}|${ARCHIVE_REOPEN_BASELINE_FIELD}|${ARCHIVE_BASELINE_ID_FIELD}):`,
        ).test(line.trim()),
    )
    .join("\n");
  const reopenLastSeen = String(baseline?.reopenLastSeen ?? "");
  const rebuilt = baseline
    ? [
        stripped,
        `${ARCHIVE_BASELINE_FIELD}: ${JSON.stringify(String(baseline.lastSeen ?? ""))}`,
        ...(reopenLastSeen
          ? [
              `${ARCHIVE_REOPEN_BASELINE_FIELD}: ${JSON.stringify(reopenLastSeen)}`,
            ]
          : []),
        `${ARCHIVE_BASELINE_ID_FIELD}: ${JSON.stringify(String(baseline.sentryIssueId ?? ""))}`,
      ].join("\n")
    : stripped;
  return source.replace(block, rebuilt);
}
