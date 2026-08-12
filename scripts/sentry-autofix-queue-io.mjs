/**
 * GitHub I/O layer for the Sentry AUTOFIX selector
 * (scripts/sentry-autofix-select.mjs). Extracted from the selector (checklist
 * split-not-append rule: the selector sat above the 600-line soft cap and this
 * leg's family-dedupe work adds ~100 more) so the selector keeps only the pure
 * parse / evaluate / collapse-orchestration / report / CLI layers.
 *
 * Every `gh` read the selection leg issues lives here, and `runGh` is injectable
 * so tests drive the full flow with mocked I/O. Nothing here writes: the whole
 * selection step is read-only (the workflow's finalize job owns every write).
 * The exported names are stable — the selector and its tests import them
 * directly, no re-export shim.
 */

import { spawn } from "node:child_process";

import {
  isValidShortId,
  parseShortId,
  resolveVerdict,
} from "./sentry-triage-project-core.mjs";
import {
  ARCHIVED_LABEL,
  CODE_FIX_VERDICT_LABEL,
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  FIX_SCOPE_ARCHITECTURAL_LABEL,
  PROJECTED_LABEL,
} from "./sentry-triage-ingest.mjs";
import { autofixBranchName } from "./sentry-autofix-finalize.mjs";
import {
  declaredFamilyIds,
  familyKey,
  isLocalFamilyId,
} from "./sentry-autofix-family.mjs";

// The queue-membership label every triage stub carries (the queue contract's
// `LABEL_DEFINITIONS` self-heals it). Both per-id lookups below narrow their
// search to it so a random issue that merely quotes a SHORT-ID cannot match.
const SENTRY_TRIAGE_QUEUE_LABEL = "sentry-triage";

// The verdict label the select scans for — re-exported from the ingest's single
// source of truth (`code-fix` maps to this label), so a future rename can't
// desync selection from the finalize marker re-read that shares the constant.
export const AUTOFIX_SELECT_LABEL = CODE_FIX_VERDICT_LABEL;

// The one Sentry project whose source lives in THIS repo (ui-dashboard).
// affected_repo `mento-protocol/monitoring-monorepo` corresponds to this
// project (queue contract / verdict contract). The queue title carries the
// project — `[sentry] <SHORT-ID> (<project>, <level>)` — so the batch list can
// cheaply pre-filter to this project BEFORE the per-candidate verdict read.
// This is the starvation guard: `sentry:verdict-code-fix` is never removed, so
// EXTERNAL-repo code-fix stubs (the majority — most Sentry projects are not the
// dashboard) would otherwise accumulate forever and, oldest-first, fill the
// list window ahead of any local candidate. The verdict's affected_repo stays
// the authority (checked in evaluateCandidate); a stub whose project is this
// one but whose verdict names another repo is a triage error whose fix would
// not live here anyway, so dropping it here is the correct, cheap direction.
export const LOCAL_SENTRY_PROJECT = "analytics-mento-org";

const QUEUE_TITLE_PROJECT_PATTERN = /^\[sentry\]\s+\S+\s+\(([^,)]+)[,)]/;

/** Extract the Sentry project from a queue-stub title, or null when unparsable. */
export function parseProject(title) {
  const match = QUEUE_TITLE_PROJECT_PATTERN.exec(String(title ?? ""));
  return match ? match[1].trim() : null;
}

// Generous list window: with fixed stubs excluded server-side and the project
// pre-filter above, the eligible-and-unfixed local set stays tiny, so this is
// only a safety ceiling — not the throttle. Oldest-first, so genuinely old
// candidates are never starved by newer ones.
const LIST_LIMIT = 200;

export function defaultRunGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(new Error(`gh ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (status) => {
      if (status !== 0) {
        reject(
          new Error(
            `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Oldest-first list of candidate `sentry:verdict-code-fix` queue stubs. Two
 * server-side narrowings keep the fixed-window from starving out genuinely-old
 * candidates (the verdict label is never removed, so stubs accumulate):
 *   - `-label:sentry:fix-pr-opened -label:sentry:fix-refused` excludes stubs
 *     this leg already handled (opened a PR for, or attempted and refused);
 *   - the LOCAL_SENTRY_PROJECT title pre-filter (applied here, client-side off
 *     the returned title) drops EXTERNAL-repo code-fix stubs before their
 *     verdict is ever read.
 * Oldest-first via `sort:created-asc`, capped at LIST_LIMIT as a safety ceiling.
 */
export async function listCodeFixStubs(runGh, repo) {
  const stdout = await runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    AUTOFIX_SELECT_LABEL,
    "--state",
    "all",
    // Exclude everything that does not belong in the window AT THE SOURCE:
    // `--limit` caps what the API RETURNS before any client-side filter runs,
    // so an accumulating backlog of not-for-us stubs that sort BEFORE newer
    // local candidates would silently starve them out of the window. Two axes:
    //   - Handled/external markers: `fix-pr-opened` (a PR was opened) and
    //     `fix-refused` (an attempt declined) are terminal until a human clears
    //     them or a regression sheds them; `sentry:projected` marks external
    //     code-fix stubs whose verdict was projected into the owning repo;
    //     `sentry:archived` marks a stub whose Sentry issue is archived
    //     (archived_until_escalating) — spending an autofix run on an issue the
    //     archive loop deliberately silenced is wrong on its own, and because
    //     nothing else ever removes it from this window (a regression sheds it
    //     via REOPEN_SHED_LABELS along with the verdict label, which then makes
    //     the stub a fresh candidate), an archived stub would otherwise cost a
    //     full `issue view` on every run forever.
    //   - Owning PROJECT, by title: the `sentry:projected` exclusion alone is
    //     not enough — the projection workflow's documented `skipped-no-token`
    //     path CLOSES external code-fix stubs while KEEPING the verdict label
    //     and WITHOUT adding `sentry:projected`, so those would slip past the
    //     label filter and fill the window. `<slug> in:title` restricts to
    //     titles containing this repo's Sentry project slug; GitHub tokenizes
    //     the hyphenated slug and ANDs the tokens (`analytics` AND `mento` AND
    //     `org`), which — across the org's `*-mento-org` / `*-api` / `-dapp`
    //     projects — matches only this project's stubs. The exact client-side
    //     `parseProject === LOCAL_SENTRY_PROJECT` check below stays as the
    //     precise gate (this server filter only needs to keep the WINDOW local).
    //   - fix_scope architectural (#1812): a local code-fix verdict whose scope
    //     is architectural is open human design work the autofix leg never
    //     selects. Settlement labels it `sentry:fix-scope-architectural` and the
    //     record-run backfill labels the legacy stubs, so this fifth `-label:`
    //     term excludes the whole architectural class — the fail-closed value
    //     every pre-#1785 verdict normalizes to — at the SOURCE. Without it that
    //     class is the only monotonic growth driver left in the window (#1813):
    //     it is skipped on scope every run and never gets a terminal marker, so
    //     it would accumulate forever and, oldest-first, starve fresh candidates.
    //     evaluateCandidate's fix_scope re-parse stays the authority, so a stale
    //     or missing label costs one reported skip, never a wrong selection.
    "--search",
    `sort:created-asc -label:"${FIX_PR_OPENED_LABEL}" -label:"${FIX_REFUSED_LABEL}" -label:"${PROJECTED_LABEL}" -label:"${ARCHIVED_LABEL}" -label:"${FIX_SCOPE_ARCHITECTURAL_LABEL}" ${LOCAL_SENTRY_PROJECT} in:title`,
    "--json",
    "number,title,labels,createdAt",
    "--limit",
    String(LIST_LIMIT),
  ]);
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [];
  return (
    list
      .map((issue) => ({
        number: issue.number,
        title: issue.title ?? "",
        createdAt: issue.createdAt ?? "",
        labels: (issue.labels ?? [])
          .map((label) => (typeof label === "string" ? label : label?.name))
          .filter(Boolean),
      }))
      // Exact owning-project gate — the server-side `<slug> in:title` filter
      // keeps the WINDOW local (tokenized, so approximate); this parses the
      // exact project out of the title and drops any tokenized false-positive.
      .filter((issue) => parseProject(issue.title) === LOCAL_SENTRY_PROJECT)
      // `--search sort:created-asc` returns oldest-first, but keep the client-side
      // sort as defense-in-depth (same pattern as the triage select job).
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  );
}

/**
 * How many distinct declared family ids one run may look up — a per-RUN budget,
 * shared across the initial declared-id pass AND the fixpoint's re-checks of
 * reverse-surfaced hub ids (see `resolveFamilies`). Each candidate's fan-out is
 * already MAX_DUPLICATE_LOOKUPS-bounded, but the distinct union across a full
 * window (plus the ids the reverse probe surfaces) could still be large; overflow
 * ids are treated as NOT-handled — failing toward MORE candidates, the family
 * module's documented safe direction — with a stderr note AND a run-record line
 * (the overflow count is threaded out through the shared `budget`).
 */
export const MAX_HANDLED_ID_QUERIES = 40;

/**
 * Family keys that already carry a TERMINAL autofix marker
 * (`sentry:fix-pr-opened` / `sentry:fix-refused`) — the family-collapse input
 * `listCodeFixStubs` structurally cannot provide, because it excludes exactly
 * these stubs from the candidate window. Without it, a refused representative
 * strands its family: after `ANALYTICS-MENTO-ORG-2E` (#1304) was refused, its
 * four siblings are the only members left in the window, each pointing back at a
 * stub the selector can no longer see, so they return one per run and re-burn
 * the cap on a root cause the leg already declined.
 *
 * Keyed on the DECLARED id, not a position in a recent window (PR #1810 bug C).
 * The prior design listed both terminal-marker sets in bulk
 * (`sort:created-desc --limit 200`) and read a candidate's siblings out of that
 * recent slice — so a blocker sitting past row 200 (a terminal sibling deep in
 * the ledger) was invisible and its family re-attempted forever. Here each
 * declared id `<ID>` runs ONE query `"<ID>" in:title label:"sentry-triage"`,
 * then the exactly-matching stub's labels decide it: keyed on the referenced id,
 * a terminal sibling 500 stubs deep is still found, and truncation is
 * structurally impossible at any ledger size.
 *
 * ONE query covers BOTH markers with no OR-label syntax: the search narrows to
 * queue stubs of this family, and the marker check is client-side off the
 * returned labels. The parsed-short-id + project recheck fences GitHub's
 * tokenized search, so a fuzzy near-miss (a different suffix that tokenizes the
 * same) is dropped.
 */
export async function listHandledShortIds(
  runGh,
  repo,
  declaredIds,
  options = {},
) {
  // `queried` (already-looked-up ids) and `budget` (remaining allowance +
  // accumulated overflow) are shared across the run's calls, so a second pass on
  // reverse-surfaced ids neither re-queries an id nor exceeds the per-run cap.
  // Absent (a standalone call), each defaults fresh, preserving the single-call
  // cap-at-40 behaviour exactly.
  const queried = options.queried instanceof Set ? options.queried : new Set();
  const budget = options.budget ?? {
    remaining: MAX_HANDLED_ID_QUERIES,
    overflow: 0,
  };
  const ids = [
    ...new Set(
      (Array.isArray(declaredIds) ? declaredIds : [])
        .map((id) => familyKey(id))
        .filter((id) => id.length > 0),
    ),
  ].filter((id) => !queried.has(id));
  const capacity = Math.max(0, budget.remaining ?? 0);
  const queryIds = ids.slice(0, capacity);
  if (ids.length > queryIds.length) {
    const dropped = ids.length - queryIds.length;
    budget.overflow = (budget.overflow ?? 0) + dropped;
    process.stderr.write(
      `note: ${ids.length} distinct declared family ids exceed the per-run MAX_HANDLED_ID_QUERIES budget (${MAX_HANDLED_ID_QUERIES}); ${dropped} are treated as not-handled this run (fails toward MORE candidates).\n`,
    );
  }
  budget.remaining = capacity - queryIds.length;
  const handled = new Set();
  for (const id of queryIds) {
    queried.add(id);
    const stdout = await runGh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      `"${id}" in:title label:"${SENTRY_TRIAGE_QUEUE_LABEL}"`,
      "--json",
      "number,title,labels",
      "--limit",
      "20",
    ]);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = [];
    }
    for (const issue of Array.isArray(parsed) ? parsed : []) {
      const title = issue.title ?? "";
      // Exact-parse fence over GitHub's tokenized search: the parsed short-id
      // AND the parsed project must match this id exactly.
      if (familyKey(parseShortId(title)) !== id) continue;
      if (parseProject(title) !== LOCAL_SENTRY_PROJECT) continue;
      const labels = (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter(Boolean);
      if (
        labels.includes(FIX_PR_OPENED_LABEL) ||
        labels.includes(FIX_REFUSED_LABEL)
      ) {
        handled.add(id);
        break;
      }
    }
  }
  return [...handled];
}

/**
 * Read a stub and resolve its verdict through the SAME authorship/regression
 * fence the label step uses, memoised by issue number for the run. Returns the
 * parsed verdict, or `null` when the stub cannot be read or carries no usable
 * fenced verdict (a comment mention that is not a real verdict). Never throws.
 */
async function readVerdictCached(runGh, repo, number, cache) {
  const key = String(number);
  if (cache.has(key)) return cache.get(key);
  let parsed;
  try {
    const full = await readStub(runGh, repo, number);
    parsed = resolveVerdict(full, number).parsed;
  } catch {
    parsed = null;
  }
  cache.set(key, parsed);
  return parsed;
}

/**
 * How many distinct reverse `in:comments` probes one RUN may issue — the bug-B
 * mirror of MAX_HANDLED_ID_QUERIES, and the missing sibling of it before PR
 * #1810's follow-up. `probeIds` is the union of the finalists' family members,
 * and a family can hold up to MAX_FAMILY_MEMBERS ids, so a cap-2 finalist set of
 * two large duplicate families could otherwise fan out to ~80 `in:comments`
 * SEARCH queries per iteration (secondary-rate-limited, not the ~1s REST call the
 * cost ceiling assumed) with no bound but MAX_FAMILY_MEMBERS × cap ×
 * MAX_REVERSE_ITERATIONS. Bounding it here — counting distinct probes across the
 * whole fixpoint via the shared `alreadyProbed` set — makes the documented gh
 * ceiling a real bound. Overflow probe ids are treated as NOT-probed (no edge,
 * no blocker), which fails toward MORE candidates — the same safe direction the
 * handled-id budget takes — with a stderr note and a run-record line.
 */
export const MAX_REVERSE_PROBE_QUERIES = 40;

/**
 * Per-search page size for the reverse `in:comments` probes. 5x headroom over the
 * live queue scale, the same class of fix as #1808: a `--limit` sized to today's
 * ledger silently drops page-2 hits, so a terminal sibling that falls past the
 * first page is missed and its candidate burns another autofix run. The bound
 * stays finite by design — we do NOT paginate-until-found. Instead a search that
 * comes back with a FULL page (`hits.length >= REVERSE_SEARCH_LIMIT`, meaning
 * there may be a page 2 we never read) flips the function's `truncated` flag, so
 * the existing run-record surface reports the shortfall exactly as the probe
 * budget does — bounded-and-surfaced, matching #1808.
 */
export const REVERSE_SEARCH_LIMIT = 100;

/**
 * How many DISTINCT stub reads (`gh issue view` via `readVerdictCached`) the whole
 * reverse fixpoint may spend admitting hits. MAX_REVERSE_PROBE_QUERIES bounds the
 * `in:comments` SEARCHES, but each search returns up to REVERSE_SEARCH_LIMIT (100)
 * rows and every unseen row costs one authoritative verdict re-read before the
 * fence can reject it — so without this the verify-read leg fans out to
 * MAX_REVERSE_PROBE_QUERIES × REVERSE_SEARCH_LIMIT (40 × 100 = 4000) subprocesses,
 * and the pipeline note's "~40 cached verify reads" ceiling term is a hope, not a
 * bound. Bounding it here — counting only cache-MISS reads across the fixpoint via
 * the shared `verifyBudget`, so a re-encountered stub stays free — makes the
 * documented gh ceiling real for this leg too. At the ceiling the remaining hits
 * are treated as NOT-admitted (no edge, no blocker), which fails toward MORE
 * candidates — the same safe direction the probe and handled-id budgets take — and
 * flips the same `truncated` flag so the shortfall surfaces on the run record.
 */
export const MAX_REVERSE_VERIFY_READS = 40;

/**
 * Reverse-verify the FINALISTS' families (PR #1810 bug B). The forward
 * `duplicate_of` graph misses two shapes the collapse must still catch: a
 * finalist that declares NOTHING but is named by a handled sibling, and a hub id
 * two stubs share through an issue that is not a candidate. For each probe id
 * (the finalists' family member ids), ONE search
 * `"<ID>" in:comments label:"sentry-triage"` surfaces the stubs whose comments
 * reference it.
 *
 * A hit is admitted ONLY after the authoritative recheck: its verdict is
 * re-parsed through the same fence, and the probed id must actually appear in
 * that parsed `duplicate_of` (via `declaredFamilyIds` — the same project-scoped,
 * self-excluding, MAX_DUPLICATE_LOOKUPS-bounded set the forward path consumes),
 * with a title that parses to a valid SHORT-ID — a casual comment mention can
 * never forge an edge. An admitted hit joins the hub's WHOLE declared family
 * into the collapse's union (an edge from the hit to each of its local declared
 * ids, not just the probed one — so a hub H that names both the finalist P and a
 * terminal sibling Q pulls Q into P's family, where the caller's handled-recheck
 * can then read Q's own marker and stand the family down; probing P alone left
 * Q's edge on the floor). An admitted hit that ALSO carries a terminal marker
 * (fix-pr-opened / fix-refused) becomes a BLOCKER (its key joins
 * handledShortIds) directly: a present terminal marker WINS over the
 * architectural hold (#1812 Finding 3), because it means a real terminal
 * outcome — an open PR, or a refusal — and a mechanical sibling must not start a
 * duplicate. The architectural hold makes a stub a pure CONNECTOR — edges only,
 * never a blocker — ONLY when NEITHER terminal marker is present; its edges
 * still restore the edge-carrier role the window's label exclusion removed from
 * the family graph (an excluded architectural anchor declaring [A, C] still
 * unions its mechanical siblings into one family).
 *
 * Fail-SOFT, same direction as `openAutofixPrExists`: a `gh` failure on one
 * probe skips that probe this run (at worst one self-terminating extra attempt),
 * never rejecting out of selection. `alreadyProbed` carries across the caller's
 * fixpoint iterations so no id is queried twice AND so the per-run
 * MAX_REVERSE_PROBE_QUERIES budget bounds the whole fixpoint, not one call;
 * `verifyBudget` likewise carries across iterations so the per-run
 * MAX_REVERSE_VERIFY_READS cap bounds the hit-verification reads across the whole
 * fixpoint, not one probe. Returns
 * `{ edges: [[hitKey, declaredKey]], blockers: [hitKey], truncated }` —
 * `truncated` true when the per-run probe budget was reached (some finalists left
 * unverified), OR a single probe came back with a full REVERSE_SEARCH_LIMIT page
 * (a sibling may sit on an unread page 2), OR the per-run verify-read budget was
 * exhausted (some hits left unread and so un-admitted). All three leave the
 * fixpoint incomplete, failing toward MORE candidates, and all surface on the
 * same run-record line.
 */
export async function reverseVerifyFamilies(
  runGh,
  repo,
  probeIds,
  options = {},
) {
  const project = options.project;
  const stubCache = options.stubCache ?? new Map();
  const probed = options.alreadyProbed ?? new Set();
  // Shared across the caller's fixpoint iterations (like `probed`), so the
  // per-run verify-read cap bounds the whole reverse leg, not one call. Absent
  // (a standalone call), it defaults fresh, preserving cap-at-N per call.
  const verifyBudget = options.verifyBudget ?? {
    remaining: MAX_REVERSE_VERIFY_READS,
  };
  const edges = [];
  const blockers = new Set();
  let truncated = false;
  for (const rawId of Array.isArray(probeIds) ? probeIds : []) {
    const probeId = familyKey(rawId);
    // Foreign-project, bare-slug, or shape-invalid ids never probe: they cannot
    // be a local family member, and the key is also interpolated into a stderr
    // note below, where a newline would inject a workflow command.
    if (!isLocalFamilyId(probeId, project)) continue;
    if (probed.has(probeId)) continue;
    // Per-run probe budget (counts distinct LOCAL probes across the fixpoint via
    // the shared `probed` set). At the ceiling, stop probing and treat the rest
    // as not-probed — fewer blockers, MORE candidates, the safe direction.
    if (probed.size >= MAX_REVERSE_PROBE_QUERIES) {
      truncated = true;
      break;
    }
    probed.add(probeId);
    let hits;
    try {
      const stdout = await runGh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--search",
        `"${probeId}" in:comments label:"${SENTRY_TRIAGE_QUEUE_LABEL}"`,
        "--json",
        "number,title,labels",
        "--limit",
        String(REVERSE_SEARCH_LIMIT),
      ]);
      hits = JSON.parse(stdout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `note: reverse family search for ${probeId} failed (${message}); skipping this probe.\n`,
      );
      continue;
    }
    // A full page means `--limit` capped what the API returned before any
    // client-side filter ran: a page-2 hit — possibly the terminal sibling —
    // went unread. Surface it (do NOT paginate); the finalist gets one bounded,
    // self-terminating extra attempt rather than a silent miss (the #1808 class).
    if (Array.isArray(hits) && hits.length >= REVERSE_SEARCH_LIMIT) {
      truncated = true;
    }
    for (const hit of Array.isArray(hits) ? hits : []) {
      const hitShortId = parseShortId(hit.title ?? "");
      if (!isValidShortId(hitShortId)) continue;
      const hitKey = familyKey(hitShortId);
      if (hitKey === probeId) continue;
      // Per-run verify-read budget: a hit already in the cache is free (no
      // subprocess), but an UNSEEN one costs a `gh issue view`. At the cap, leave
      // the remaining unseen hits unread — un-admitted, so fewer blockers and
      // MORE candidates — and surface it on the run record. `stubCache.has` mirrors
      // `readVerdictCached`'s own cache check exactly, so the budget is charged for
      // precisely the calls that spawn a subprocess.
      if (!stubCache.has(String(hit.number))) {
        if (verifyBudget.remaining <= 0) {
          truncated = true;
          continue;
        }
        verifyBudget.remaining -= 1;
      }
      const parsed = await readVerdictCached(
        runGh,
        repo,
        hit.number,
        stubCache,
      );
      if (!parsed) continue;
      // The hub's WHOLE declared local family (project-scoped, self-excluded,
      // MAX_DUPLICATE_LOOKUPS-bounded — the forward path's exact rule). The probe
      // is admitted only if the hub genuinely names it; then EVERY declared id
      // joins the hub, so a terminal sibling the hub names alongside the finalist
      // is pulled into the same family for the caller's handled-recheck.
      const hubFamily = declaredFamilyIds(
        hitShortId,
        parsed.duplicateOf ?? [],
        project,
      );
      if (!hubFamily.includes(probeId)) continue;
      for (const declaredKey of hubFamily) edges.push([hitKey, declaredKey]);
      const labels = (hit.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter(Boolean);
      // Terminal marker WINS over the architectural hold (#1812 Finding 3): a
      // present fix-pr-opened / fix-refused means this sibling reached a real
      // terminal outcome — an open PR, or a refusal — so the family stands down
      // and a mechanical sibling must NOT start a duplicate. The hold makes a
      // stub a pure CONNECTOR — edges only, never a blocker — ONLY when NEITHER
      // terminal marker is present; the edges above are pushed regardless, so an
      // excluded architectural anchor declaring [A, C] still unions its
      // mechanical siblings into one family (the fan-out the window's label
      // exclusion removed). A stub carrying BOTH a terminal marker AND the hold
      // therefore blocks on the terminal marker — the architectural label never
      // downgrades a present terminal outcome to a mere connector.
      if (
        labels.includes(FIX_PR_OPENED_LABEL) ||
        labels.includes(FIX_REFUSED_LABEL)
      ) {
        blockers.add(hitKey);
      }
    }
  }
  if (truncated) {
    process.stderr.write(
      `note: reverse family verification was truncated this run — the per-run probe budget (${MAX_REVERSE_PROBE_QUERIES}) or verify-read budget (${MAX_REVERSE_VERIFY_READS}) was reached, or a probe returned a full page; the unreached hits/probes are treated as not-admitted (fails toward MORE candidates).\n`,
    );
  }
  return { edges, blockers: [...blockers], truncated };
}

/** Read a queue stub's title/labels/comments so it can be evaluated in full. */
export async function readStub(runGh, repo, number) {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,title,body,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean),
    comments: data.comments ?? [],
  };
}

// `gh pr list --head <branch>` matches by branch NAME, and a pull request opened
// from a FORK carries its own head branch name — so `--head` returns fork PRs
// too. Verified live against a public repo: `gh pr list -R cli/cli --head
// feat/uptime-command --state open --json isCrossRepository,headRepositoryOwner`
// returns `{"isCrossRepository":true,"headRepositoryOwner":{"login":
// "seanturner83"}}`. This repo is public, queue-stub titles are public, and
// `autofixBranchName` is deterministic, so ANY GitHub user can fork it, push
// `sentry-autofix/<short-id-lower>`, and open a PR at main. Without this fence
// that PR is read as OUR prior fix PR: the stub routes to the reconcile path,
// which comments the attacker's PR url onto the queue issue and applies
// `sentry:fix-pr-opened` — terminal until a human clears it — and the family
// collapse then stands the whole duplicate family down behind it.
//
// The head branch is one-to-one with the SHORT-ID only WITHIN this repo, so
// ownership has to be asserted, not assumed. Both signals must affirm it.
export const HEAD_OWNERSHIP_FIELDS =
  "number,isCrossRepository,headRepositoryOwner";

/** True when `pr` is a same-repo PR of `repo` — i.e. one this pipeline could
 * have opened. Fails CLOSED: a missing or unexpected field is "not ours", which
 * costs at most a re-attempt on a branch that already has our PR (`gh pr create`
 * refuses a second one) and never hands an outsider the reconcile write path. */
export function isOwnHeadPr(pr, repo) {
  const owner = String(repo ?? "")
    .split("/")[0]
    .toLowerCase();
  if (!owner) return false;
  return (
    pr?.isCrossRepository === false &&
    String(pr?.headRepositoryOwner?.login ?? "").toLowerCase() === owner
  );
}

/** True when an OPEN autofix PR already exists for this SHORT-ID — the autofix
 * leg must never open a second fix PR for a Sentry issue that already has one.
 * Matched by the DETERMINISTIC head branch (`sentry-autofix/<short-id-lower>`),
 * NOT by a text search: a free-text `--search "<SHORT-ID>"` matches any open PR
 * whose body/title merely mentions the id (a human PR, a dependency bump, an
 * unrelated fix that cites the Sentry issue), which would both falsely dedup an
 * eligible stub out of selection AND — via the reconcile path — mislabel the
 * stub `sentry:fix-pr-opened` pointing at that unrelated PR. `--state open`
 * only: a merged/closed PR is not a live dedup (a regressed, re-triaged issue
 * must be re-attemptable). The branch name is derived from the shape-validated
 * SHORT-ID and transits `gh` as an argv element, so it can't inject.
 *
 * NOT `--limit 1`: fork PRs share the branch-name namespace (see above), so a
 * single-row window can be filled by a spoof and hide our own PR behind it —
 * which would make the leg try to open a second one. Take a small page and let
 * `isOwnHeadPr` pick ours out of it. */
export async function openAutofixPrExists(runGh, repo, shortId) {
  const stdout = await runGh([
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    autofixBranchName(shortId),
    "--state",
    "open",
    "--json",
    HEAD_OWNERSHIP_FIELDS,
    "--limit",
    "20",
  ]);
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : []).some((pr) =>
    isOwnHeadPr(pr, repo),
  );
}
