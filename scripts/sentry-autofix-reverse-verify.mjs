/**
 * Reverse-family verification for the Sentry AUTOFIX selector (PR #1810 bug B).
 * Extracted from scripts/sentry-autofix-queue-io.mjs, which crossed the 600-line
 * soft cap once the #1784 family-dedupe work landed there, so the I/O layer keeps
 * the forward queue reads and this module owns the reverse `in:comments` probe —
 * the leg that catches a finalist named by a handled sibling, or a hub id two
 * stubs share through a non-candidate issue.
 *
 * `runGh` is injectable (the select suite drives the whole flow with mocked I/O);
 * the reverse probe reads only (`gh issue list`/`view`), never writes. The
 * exported names are stable — sentry-autofix-family-resolve.mjs and the select
 * suite import them directly, no re-export shim.
 */

import {
  isValidShortId,
  parseShortId,
  resolveVerdict,
} from "./sentry-triage-project-core.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
} from "./sentry-triage-ingest.mjs";
import {
  declaredFamilyIds,
  familyKey,
  isLocalFamilyId,
} from "./sentry-autofix-family.mjs";
import {
  readStub,
  SENTRY_TRIAGE_QUEUE_LABEL,
} from "./sentry-autofix-queue-io.mjs";

/**
 * Read a stub and resolve its verdict through the SAME authorship/regression
 * fence the label step uses, memoised by issue number for the run. Returns the
 * parsed verdict, or `null` when the stub cannot be read or carries no usable
 * fenced verdict (a comment mention that is not a real verdict). Never throws.
 */
async function readVerdictCached(runGh, repo, number, cache, failedReads) {
  const key = String(number);
  if (cache.has(key)) return cache.get(key);
  let parsed;
  try {
    const full = await readStub(runGh, repo, number);
    parsed = resolveVerdict(full, number).parsed;
  } catch {
    parsed = null;
    // A FAILED read is cached as `null` so one broken stub cannot be re-read once
    // per fixpoint iteration — but that null is spend, not knowledge, and it is
    // indistinguishable from the legitimate "read fine, carries no fenced
    // verdict". Recording the key here is what lets the caller keep the negative
    // cache inside this pass and refuse to SEED it into the next one.
    failedReads?.add(key);
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
 * fixpoint iterations (and, for the selector's second look, across PASSES) so no
 * id is queried twice; the separate `probeBudget` counter is what bounds the
 * per-run MAX_REVERSE_PROBE_QUERIES spend across the whole fixpoint, kept apart
 * from the dedupe set so a seeded set cannot read as a spent budget;
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
  // The ANSWERED subset of `probed`: probes whose search came back AND whose
  // every hit was verified within budget. `probed` alone is a re-attempt guard
  // and absorbs probes that failed or were left half-read — spend, not
  // knowledge — so only this set may be seeded into a pass with a fresh budget.
  // (A probe cut off by the PROBE budget never reaches `probed` at all: the
  // ceiling check breaks before the add.) Optional: a standalone call keeps its
  // previous behaviour exactly.
  const answeredProbes = options.answeredProbes ?? null;
  const failedStubReads = options.failedStubReads ?? new Set();
  // Shared across the caller's fixpoint iterations (like `probed`), so the
  // per-run verify-read cap bounds the whole reverse leg, not one call. Absent
  // (a standalone call), it defaults fresh, preserving cap-at-N per call.
  const verifyBudget = options.verifyBudget ?? {
    remaining: MAX_REVERSE_VERIFY_READS,
  };
  // `maxProbes` overrides the per-run probe cap for ONE resolve pass — the
  // selector's bounded second look runs on a smaller allowance because the first
  // pass already spent the module default. Absent, the default applies.
  const maxProbes = Number.isInteger(options.maxProbes)
    ? options.maxProbes
    : MAX_REVERSE_PROBE_QUERIES;
  // The budget is a COUNTER, not `probed.size`. The two were the same while
  // `alreadyProbed` started empty on every resolve pass, but the selector's
  // second look now SEEDS it with the first pass's probed ids (so it does not
  // re-issue searches the run already paid for) — and with `probed.size` as the
  // meter, a seeded set of 40 would read as "budget already spent" and the
  // second look would probe NOTHING while reporting `truncated`. Shared across
  // the caller's fixpoint iterations exactly like `verifyBudget`, so the per-run
  // cap still bounds the whole reverse leg rather than one call.
  const probeBudget = options.probeBudget ?? { remaining: maxProbes };
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
    // Per-run probe budget (counts distinct LOCAL probes ISSUED across the
    // fixpoint). At the ceiling, stop probing and treat the rest as not-probed —
    // fewer blockers, MORE candidates, the safe direction.
    if (probeBudget.remaining <= 0) {
      truncated = true;
      break;
    }
    probeBudget.remaining -= 1;
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
    // Whether THIS probe left any hit unresolved — starved of verify budget, or
    // read and thrown. Either way the probe's own answer is incomplete: the hit
    // it could not read may be the terminal sibling, and only re-probing on a
    // fresh budget can reach it.
    //
    // A full page above does NOT count. That truncation is structural — the API
    // returned `--limit` rows and page 2 is unreachable by design — so a re-probe
    // would return the identical page and learn nothing; spending a fresh
    // budget on it would be pure waste.
    let hitUnresolved = false;
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
          hitUnresolved = true;
          continue;
        }
        verifyBudget.remaining -= 1;
      }
      const parsed = await readVerdictCached(
        runGh,
        repo,
        hit.number,
        stubCache,
        failedStubReads,
      );
      // A THROWN read leaves this hit unresolved too — and unlike a hit that
      // read fine and simply carries no fenced verdict (also `parsed == null`,
      // and a real answer), it is worth retrying. Checked on the shared set, so
      // a hit whose read failed in an earlier iteration and now returns from the
      // negative cache still marks THIS probe incomplete.
      if (failedStubReads.has(String(hit.number))) hitUnresolved = true;
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
    // The probe is ANSWERED only now: its search returned AND every hit it
    // surfaced was resolved. A `continue` on search failure above never reaches
    // this line, which is the point.
    if (!hitUnresolved) answeredProbes?.add(probeId);
  }
  if (truncated) {
    process.stderr.write(
      `note: reverse family verification was truncated this pass — the probe budget (${maxProbes}) or verify-read budget was reached, or a probe returned a full page; the unreached hits/probes are treated as not-admitted (fails toward MORE candidates).\n`,
    );
  }
  return { edges, blockers: [...blockers], truncated };
}
