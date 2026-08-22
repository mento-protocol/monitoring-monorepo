/**
 * The Sentry triage agent's broker guard (issue #1956).
 *
 * Split out of `sentry-triage-agent-comment.mjs`, which owns a different
 * question. The wrapper asks "may this BODY be posted, to which issue"; this
 * module asks "is the evidence behind it still trustworthy, and what may we say
 * about the failure in public". The two share only the `$RUNNER_TEMP` root.
 *
 * A DEAD BROKER IS NOT A VERDICT. The Sentry credential broker runs backgrounded
 * in the same job, and its exit fails no step: the job must END with the agent,
 * so nothing runs afterwards to notice, and a background process can neither
 * write the job log nor fail a sibling step. A broker that dies mid-run
 * therefore leaves the agent reading ECONNREFUSED and reporting `needs-human` —
 * a verdict about the TOOLING that the deterministic `verdict` job cannot tell
 * apart from a judgement about the ISSUE, so it labels the stub, strips
 * `sentry:needs-triage` and parks work nobody can act on. The prompt already
 * tells the agent to post nothing in that state; this is the structural half,
 * because a prompt-injected agent is exactly the one that ignores it.
 *
 * The workflow's watchdog writes BROKER_DOWN_FILE_RELATIVE when the broker
 * goes; `assertBrokerAlive` refuses on that marker, and — because a polled
 * marker lags the death it reports — also probes the broker process directly.
 * No comment means the `verdict` job finds no verdict, fails loudly, and leaves
 * `sentry:needs-triage` for the next run.
 *
 * This module is part of the wrapper's runtime import closure, so the workflow
 * stages it read-only alongside the wrapper; the closure is recomputed from
 * source by `sentry-triage-agent-comment.test.mjs`, which fails if the staging
 * list stops matching.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Terminal marker the broker step's watchdog writes when the Sentry
 * credential broker exits while the agent is running. Fixed relative path
 * under `$RUNNER_TEMP` for the same reason as the wrapper's pinned target: an
 * env var naming the path would be one more model-reachable binding to
 * repoint.
 *
 * This one sits in the agent-WRITABLE `$RUNNER_TEMP`, and that is sound only
 * because its trigger is EXISTENCE. The agent's permitted `gh issue view …
 * --template … > path` composes into create-and-truncate (see the workflow's
 * staging banner), so it can bring this marker into being or empty it — both of
 * which refuse — but it holds nothing that unlinks or renames, so it cannot
 * clear one the watchdog wrote. Every reachable tamper is fail-CLOSED. Do not
 * make the refusal depend on the marker's CONTENTS; that would turn truncation
 * into a bypass. The pid record below has no such property, which is why it is
 * locked instead. */
export const BROKER_DOWN_FILE_RELATIVE = "sentry-mcp-broker.down";

/** The broker's pid, recorded by the trusted broker step before the agent
 * starts. The live probe below identifies the broker by THIS and by nothing in
 * the environment: `SENTRY_MCP_BROKER_PORT` is job env that the agent's own
 * shell can reassign, and a port is not an identity in any case — see
 * probeBrokerByPid.
 *
 * IN ITS OWN LOCKED DIRECTORY, not bare `$RUNNER_TEMP`. Unlike the marker this
 * record is trusted for its CONTENTS, so create-and-truncate is enough to
 * subvert it: an agent that writes a long-lived pid (its own parent, say) makes
 * a dead broker read as alive, and the post then only has to beat the
 * watchdog's poll to the marker. So the broker step publishes it 0444 inside a
 * 0555 directory — the same lock as the pinned write target — where
 * open(O_WRONLY), create, unlink and rename all fail EACCES for the owning
 * non-root user, and probeBrokerByPid refuses a record it finds writable. */
export const BROKER_PID_FILE_RELATIVE =
  "sentry-broker-identity/sentry-mcp-broker.pid";

/** Where the broker watchdog leaves its terminal marker. */
export function brokerDownFilePath(env) {
  const tempDir = String(env.RUNNER_TEMP ?? "");
  if (tempDir === "") throw new Error("RUNNER_TEMP must be set");
  return join(tempDir, BROKER_DOWN_FILE_RELATIVE);
}

/** Where the broker step recorded the broker's pid. */
export function brokerPidFilePath(env) {
  const tempDir = String(env.RUNNER_TEMP ?? "");
  if (tempDir === "") throw new Error("RUNNER_TEMP must be set");
  return join(tempDir, BROKER_PID_FILE_RELATIVE);
}

// ── publishing the broker log without publishing Sentry coordinates ──────────

/** What a redacted coordinate reads as. Deliberately not empty: the reader must
 * see that a segment was there. */
export const REDACTED_SEGMENT = "<redacted>";

/** Marks a coordinate POSITION in a route below. */
const COORDINATE = "*";

/**
 * Every Sentry Web API route the broker's allowlist admits, with `*` marking
 * the positions that hold a coordinate rather than route structure.
 *
 * POSITIONAL, NOT A VOCABULARY. An earlier version asked "is this segment one
 * of the known route words?" and published any coordinate whose value happened
 * to equal one — an organization literally named `events`, a monitor slug
 * `replays`, a project slug `images`. Route words are not a reserved namespace,
 * so membership can never answer the question. A segment is a coordinate
 * because of WHERE it sits in a matched route, and nothing else.
 *
 * Kept in step with the broker's own ALLOWED_PATHS by
 * `sentry-triage-agent-comment.test.mjs`, which re-derives this table from
 * `scripts/sentry/broker/sentry-mcp-broker.mjs` and fails on any difference.
 * The broker is deliberately NOT imported here: this module is staged read-only
 * into the agent's job as part of the wrapper's closure, and pulling the
 * broker's module in would widen that closure for no runtime benefit.
 */
export const SENTRY_ROUTES = [
  "/api/0/organizations/",
  "/api/0/organizations/*/",
  "/api/0/organizations/*/projects/",
  "/api/0/organizations/*/issues/",
  "/api/0/organizations/*/issues/*/",
  "/api/0/organizations/*/issues/*/events/latest/",
  "/api/0/organizations/*/issues/*/events/*/",
  "/api/0/organizations/*/issues/*/autofix/",
  "/api/0/organizations/*/issues/*/external-issues/",
  "/api/0/organizations/*/replay-count/",
  "/api/0/organizations/*/events/",
  "/api/0/organizations/*/events/validate/",
  "/api/0/organizations/*/replays/",
  "/api/0/organizations/*/replays/*/",
  "/api/0/organizations/*/trace/*/",
  "/api/0/organizations/*/trace-meta/*/",
  "/api/0/organizations/*/ai-conversations/*/",
  "/api/0/organizations/*/monitors/*/",
  "/api/0/organizations/*/preprodartifacts/snapshots/*/",
  "/api/0/organizations/*/preprodartifacts/snapshots/*/images/*/",
  "/api/0/projects/*/*/",
];

const ROUTE_SEGMENTS = SENTRY_ROUTES.map((route) => route.split("/"));

/** Count of coordinate positions, used to break a tie toward more redaction. */
const coordinateCount = (segments) =>
  segments.filter((segment) => segment === COORDINATE).length;

/**
 * Render one observed pathname through the routes.
 *
 * The rendering is built from the ROUTE, never from the observed path, so a
 * matched coordinate cannot survive whatever it happens to contain. Where two
 * routes both match, the one that redacts MORE wins — ties go to safety, not to
 * legibility.
 *
 * That tie-break costs exactly one route word today: `latest`. The routes
 * `…/events/latest/` and `…/events/<coordinate>/` are the same length, so an
 * event id of `latest` is indistinguishable from the literal endpoint.
 * Redacting it loses nothing that matters — the route stays legible up to
 * `/events/` — and preferring the literal instead would publish that id. The
 * test pins the ambiguous set to exactly `latest`, so it cannot silently grow.
 *
 * An UNMATCHED path (one the broker refused, or one a newer MCP server
 * produced) has no known structure, so every segment after `/api/0/` is
 * redacted. That deliberately costs the new route word: without a pattern there
 * is no way to tell a route word from an identifier, and guessing is what this
 * function exists to stop. Re-deriving the allowlist is done against a capture
 * server, per docs/notes/sentry-triage-pipeline.md — not by reading a public
 * run log.
 */
function renderPath(pathname) {
  const observed = pathname.split("/");
  let best = null;
  for (const route of ROUTE_SEGMENTS) {
    if (route.length !== observed.length) continue;
    const matches = route.every(
      (segment, index) => segment === COORDINATE || segment === observed[index],
    );
    if (!matches) continue;
    if (best === null || coordinateCount(route) > coordinateCount(best)) {
      best = route;
    }
  }
  const template =
    best ??
    // No route: keep only the `/api/0/` prefix that got us here (indices 0-2 of
    // a leading-slash split), and the empty tail segment that carries the
    // trailing slash. Everything between is a coordinate as far as we can tell.
    observed.map((segment, index) =>
      index <= 2 || segment === "" ? segment : COORDINATE,
    );
  return template
    .map((segment) => (segment === COORDINATE ? REDACTED_SEGMENT : segment))
    .join("/");
}

/**
 * Strip Sentry coordinates out of text bound for the PUBLIC job log.
 *
 * The broker logs `url.pathname` for every request it proxies, and those paths
 * carry issue, event, trace, replay, monitor, conversation and snapshot
 * identifiers. That log is agent-readable BY DESIGN — it lives under
 * `$RUNNER_TEMP` and the agent holds `Read` — but this repository is public, so
 * an unedited copy on the agent's stderr publishes those coordinates to anyone.
 * The verdict comment's permalink is the only Sentry coordinate this pipeline
 * publishes on purpose.
 *
 * Route SHAPE survives, and that is the whole diagnostic: a broker refusal
 * names the route the granted tool set produced, which is what re-derives the
 * path allowlist on an MCP-server bump. The identifiers add nothing to that.
 * Query strings go whole — they carry search terms and filters.
 */
export function redactSentryPaths(text) {
  return String(text).replace(/\/api\/0\/[^\s?]*(?:\?\S*)?/g, (match) => {
    const query = match.indexOf("?");
    const pathname = query === -1 ? match : match.slice(0, query);
    const rendered = renderPath(pathname);
    return query === -1 ? rendered : `${rendered}?${REDACTED_SEGMENT}`;
  });
}

// ── is the broker still up? ─────────────────────────────────────────────────

/** Carries the marker's contents — the watchdog's reason plus the broker log —
 * separately from the one-line refusal, because `::error::` annotations are
 * single-line and the log is what makes the failure attributable. */
export class BrokerDownError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "BrokerDownError";
    this.detail = detail;
  }
}

/** Default reader: the marker's contents, or null when it is absent. Only
 * ENOENT means absent — a marker that exists and cannot be read is the same
 * evidence as one that can, so every other error refuses rather than shrugs. */
function readBrokerDownDefault(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return null;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `refusing to post: the broker-down marker at ${path} could not be read ` +
        `(${reason}); present and unreadable is not absent.`,
      { cause: err },
    );
  }
}

/** `/proc/<pid>/status`, or null where there is no procfs to read (macOS, and
 * any kernel that does not expose it). Null refines nothing, so the signal-0
 * answer stands — this can only ever turn an "alive" into a "gone". */
function readProcStatus(pid) {
  try {
    return readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return null;
  }
}

/** Does this `/proc/<pid>/status` describe a process that has exited and is
 * only waiting to be reaped? Linux writes `State:\tZ (zombie)`. */
export function isZombieProcStatus(status) {
  if (typeof status !== "string") return false;
  return /^State:\s*Z\b/m.test(status);
}

/**
 * Default probe: is the broker PROCESS still there? Signal 0 — no signal is
 * sent, only the existence-and-permission check is performed, so this cannot
 * disturb the broker it asks about.
 *
 * The process, not its port. A connect to `127.0.0.1:<port>` answers a weaker
 * question: the kernel completes the handshake from the listen backlog while
 * the owning process is on its way out, and once the port is released anything
 * that rebinds it answers in the broker's place. The pid names one process and
 * nothing can stand in for it. It is also why the port is not read here at all.
 *
 * EPERM is refused with everything else: a pid this process may not signal is
 * not the broker it started the run with — both run as the same user.
 *
 * A ZOMBIE still has a pid, so signal 0 alone would call an exited broker
 * alive. On the hosted VM runner the orphaned broker is reparented to systemd
 * and reaped, but a `container:` job's PID 1 does not reap, and that would be a
 * silent fail-open of exactly the kind this whole mechanism exists to close —
 * so the state is read too, where the kernel exposes it.
 */
export function probeBrokerByPid(env, readStatus = readProcStatus) {
  const path = brokerPidFilePath(env);
  const directory = dirname(path);
  let raw;
  let mode;
  let directoryMode;
  try {
    raw = readFileSync(path, "utf8").trim();
    mode = statSync(path).mode;
    directoryMode = statSync(directory).mode;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `refusing to post: cannot read the broker's pid record at ${path} ` +
        `(${reason}); without it there is no way to tell whether the broker ` +
        "that produced this evidence is still up.",
      { cause: err },
    );
  }
  // A writable record is not a record. This one is trusted for its CONTENTS —
  // it names the process the whole liveness answer is about — and the agent's
  // permitted `gh issue view … --template … > path` writes arbitrary text to
  // any path this user can write. So the broker step publishes it 0444 in a
  // 0555 directory and this refuses if it ever finds otherwise, which also
  // catches that step regressing. Same rule, same reason, as the pinned target.
  //
  // THE DIRECTORY IS CHECKED FIRST, AND IT IS THE STRONGER CLAIM. A read-only
  // file inside a writable directory protects nothing: write permission on a
  // directory governs unlink and rename, not the file's own mode, so anyone
  // who can write the directory can delete the 0444 record and lay down their
  // own — or rename one over it — and then chmod it back to 0444. Verified
  // both ways on a real filesystem: at 0755 the unlink-and-recreate and the
  // rename-over both succeed and the replacement reads as 0444; at 0555 the
  // unlink is denied. So the file's mode alone answers nothing.
  if ((directoryMode & 0o222) !== 0) {
    throw new Error(
      `refusing to post: the directory holding the broker's pid record ` +
        `(${directory}) is writable (mode ` +
        `${(directoryMode & 0o777).toString(8)}), so the record inside it can ` +
        "be replaced whatever its own mode says; the workflow must lock the " +
        "directory as well as the file.",
    );
  }
  if ((mode & 0o222) !== 0) {
    throw new Error(
      `refusing to post: the broker's pid record at ${path} is writable ` +
        `(mode ${(mode & 0o777).toString(8)}), so it is not evidence of which ` +
        "process the broker is; the workflow must publish it read-only.",
    );
  }
  // The WHOLE trimmed record must be the pid. `Number.parseInt` stops at the
  // first non-digit, so "4242 garbage" or a truncated write would otherwise
  // yield a plausible pid — and asking about whatever process holds it is the
  // fail-open this check exists to prevent.
  const pid = /^[0-9]{1,10}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(
      `refusing to post: the broker's pid record at ${path} is not a pid`,
    );
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombieProcStatus(readStatus(pid));
}

/**
 * Refuse to post unless the Sentry credential broker is still up. The verdict
 * comment is the round's only outcome, so withholding it is what turns a dead
 * broker into a failed round instead of a settled stub. See the header.
 *
 * TWO CHECKS, because neither alone is enough. The watchdog's MARKER is
 * attributable — it carries the broker's log, which says WHY it died — but it
 * is published on a poll, so it lags the death by up to one interval. The LIVE
 * PROBE has no lag and no story: it answers only whether the broker process is
 * still there, at the moment of posting. A broker that dies fails the probe at
 * once and the marker shortly after, and the post is refused on whichever
 * notices first.
 *
 * The marker is read TWICE, once on each side of the probe. The probe awaits,
 * and a death inside that await is published only afterwards — so a single read
 * before it would miss exactly the case the watchdog exists to report.
 */
export async function assertBrokerAlive(
  env,
  readBrokerDown = readBrokerDownDefault,
  probeBroker = probeBrokerByPid,
) {
  const path = brokerDownFilePath(env);
  const refuseOnMarker = () => {
    const record = readBrokerDown(path);
    if (record === null || record === undefined) return;
    throw new BrokerDownError(
      "refusing to post: the Sentry credential broker exited during this " +
        `run, so every Sentry read after it went was blind (see ${path}). A ` +
        "verdict posted now would settle the stub on tooling, not evidence.",
      String(record),
    );
  };

  refuseOnMarker();
  const alive = await probeBroker(env);
  refuseOnMarker();
  if (!alive) {
    throw new BrokerDownError(
      "refusing to post: the Sentry credential broker process is gone, so it " +
        "went during this run and the reads behind this verdict cannot be " +
        "trusted. A verdict posted now would settle the stub on tooling, not " +
        "evidence.",
      `the broker's watchdog had not published ${path} yet; it lags a death ` +
        "by up to one poll interval, and this probe does not.",
    );
  }
}
