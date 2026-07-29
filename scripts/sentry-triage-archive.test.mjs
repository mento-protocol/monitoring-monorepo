#!/usr/bin/env node
import {
  ARCHIVE_COMMENT_MARKER,
  ARCHIVE_PAYLOAD,
  archiveIssue,
  buildAuditComment,
  buildFreshEventRefusalComment,
  buildUnreadableFreshnessRefusalComment,
  buildRestorePayload,
  isActivelyRegressing,
  isAlreadyArchived,
  describeSentryDisposition,
  isDefiniteRejection,
  isNotFoundError,
  isSelectableForTriage,
  isNumericId,
  settlementHeld,
  isSafeSentryPermalink,
  isSettledAuditComment,
  isUsableBaseline,
  lastSeenMoved,
  reconcileToTarget,
  sentryMayBeArchived,
  parseArgs,
  parseStubMetadata,
  resolveArchiveToken,
  resolveIssueIdFromShortId,
  restoreArchivedIssue,
  runArchive,
  sanitizeApprover,
  stubIsArchivable,
} from "./sentry-triage-archive.mjs";
import {
  parseArchiveBaseline,
  withArchiveBaseline,
} from "./sentry-triage-ingest.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`expected ${b}, got ${a}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, pattern) {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return;
  }
  throw new Error("expected function to throw");
}

async function assertRejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return;
  }
  throw new Error("expected promise to reject");
}

// ---------------------------------------------------------------------------
// Fixtures + mocks.
// ---------------------------------------------------------------------------

const TOKEN = "sntrys_archive_token";
const APPROVER = "octomaintainer";
const QUEUE_URL =
  "https://github.com/mento-protocol/monitoring-monorepo/issues/42";

function stubBody({
  shortId = "GOVERNANCE-MENTO-ORG-51",
  sentryIssueId = "6197137101",
  project = "governance-mento-org",
  permalink = "https://mento-labs.sentry.io/issues/6197137101/",
} = {}) {
  return [
    "<!-- sentry-triage:v1 -->",
    "",
    "```yaml",
    `short_id: ${JSON.stringify(shortId)}`,
    `sentry_issue_id: ${JSON.stringify(sentryIssueId)}`,
    `project: ${JSON.stringify(project)}`,
    'level: "error"',
    'status: "unresolved"',
    "events: 42",
    "users: 7",
    'first_seen: "2026-07-01T00:00:00Z"',
    'last_seen: "2026-07-14T10:00:00Z"',
    `permalink: ${JSON.stringify(permalink)}`,
    "```",
    "",
    `[View in Sentry](${permalink})`,
    "",
  ].join("\n");
}

/** A stub body as a genuine retry finds it: carrying a freshness baseline bound
 * to the Sentry issue, written by the archive that already ran. An
 * already-archived run over a body WITHOUT one is refused, so every
 * already-archived fixture that means to exercise something else needs this. */
function settledStubBody(lastSeen = BASELINE_LAST_SEEN) {
  return withArchiveBaseline(stubBody(), {
    lastSeen,
    sentryIssueId: "6197137101",
  });
}

function makeStub({
  number = 42,
  body = stubBody(),
  state = "OPEN",
  comments = [],
} = {}) {
  return {
    number,
    title: "[sentry] GOVERNANCE-MENTO-ORG-51 (governance-mento-org, error)",
    body,
    url: QUEUE_URL,
    state,
    labels: [
      { name: "sentry-triage" },
      { name: "sentry:approved-archive" },
      { name: "sentry:verdict-upstream" },
    ],
    comments,
  };
}

/**
 * A stateful in-memory GitHub issue, because the reconciler decides from LIVE
 * reads. A canned-snapshot fake cannot test it — reads have to reflect the
 * writes, or "re-read and correct what is actually wrong" has nothing to
 * observe. This also lets a test assert the FINAL state, which is the real
 * convergence question, rather than a sequence of calls.
 *
 * `failOn` throws instead of applying (a clean failure). `ambiguousOn` applies
 * the mutation and THEN throws — the lost-response shape that breaks every
 * did-we-do-it flag, and the one this round exists to handle.
 * `concurrentReopenBeforeView` runs ingest's whole reopen against the model
 * just before the Nth read returns, modelling the other workflow interleaving.
 */
function makeRunGh({
  stub,
  approvalLabelGone = false,
  failOn = () => null,
  ambiguousOn = () => null,
  // Reports success WITHOUT applying — a write that is accepted and does not
  // take effect. The mirror image of ambiguousOn, and the only thing the
  // post-correction verification read can catch.
  noopOn = () => false,
  // Runs before a call is applied, so a test can model another actor mutating
  // the stub between this run's writes.
  beforeCall = () => {},
  concurrentReopenBeforeView = null,
}) {
  const calls = [];
  let views = 0;
  const model = {
    number: stub.number,
    title: stub.title,
    url: stub.url,
    body: stub.body,
    state: stub.state,
    labels: (stub.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l?.name))
      .filter(Boolean),
    comments: [...(stub.comments ?? [])],
  };

  // Exactly what scripts/sentry-triage-ingest.mjs reopenQueueIssue does.
  const ingestReopen = () => {
    model.labels = model.labels.filter(
      (n) => !REOPEN_SHED_LABELS_FIXTURE.includes(n),
    );
    if (!model.labels.includes("sentry:needs-triage")) {
      model.labels.push("sentry:needs-triage");
    }
    model.state = "OPEN";
  };

  const snapshot = () => ({
    ...model,
    labels: model.labels.map((name) => ({ name })),
  });

  const apply = (args) => {
    const [a0, a1] = args;
    if (a0 === "label" && a1 === "create") return "";
    if (a0 === "api" && a1 === "-X") {
      const name = String(args[3]).split("/labels/")[1];
      if (approvalLabelGone || !model.labels.includes(name)) {
        throw new Error(
          `gh ${args.join(" ")} failed with exit 1:\ngh: Not Found (HTTP 404)`,
        );
      }
      model.labels = model.labels.filter((n) => n !== name);
      return "";
    }
    if (a0 === "issue" && a1 === "close") {
      model.state = "CLOSED";
      return "";
    }
    if (a0 === "issue" && a1 === "reopen") {
      model.state = "OPEN";
      return "";
    }
    if (a0 === "issue" && a1 === "comment") {
      model.comments.push({
        body: args[args.indexOf("--body") + 1],
        author: { login: "github-actions" },
      });
      return "";
    }
    if (a0 === "issue" && a1 === "edit") {
      if (args.includes("--body")) {
        model.body = args[args.indexOf("--body") + 1];
      }
      if (args.includes("--add-label")) {
        for (const n of args[args.indexOf("--add-label") + 1].split(",")) {
          if (!model.labels.includes(n)) model.labels.push(n);
        }
      }
      if (args.includes("--remove-label")) {
        const drop = args[args.indexOf("--remove-label") + 1].split(",");
        model.labels = model.labels.filter((n) => !drop.includes(n));
      }
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  const runGh = async (args) => {
    calls.push(args);
    beforeCall(args);
    // failOn covers reads too: a settlement read that throws is one of the
    // failure paths the disarm rule has to cover.
    const clean = failOn(args);
    if (clean) throw new Error(clean);
    if (args[0] === "issue" && args[1] === "view") {
      views += 1;
      if (concurrentReopenBeforeView === views) ingestReopen();
      return JSON.stringify(snapshot());
    }
    const ambiguous = ambiguousOn(args);
    if (ambiguous) {
      apply(args); // the mutation LANDS…
      throw new Error(ambiguous); // …and the response is lost.
    }
    if (noopOn(args)) return ""; // accepted, never applied
    return apply(args);
  };
  return { runGh, calls, model };
}

/** Mirrors REOPEN_SHED_LABELS so the fake sheds exactly what ingest sheds. */
const REOPEN_SHED_LABELS_FIXTURE = [
  "sentry:verdict-code-fix",
  "sentry:verdict-config-fix",
  "sentry:verdict-upstream",
  "sentry:verdict-needs-human",
  "sentry:projected",
  "sentry:fix-pr-opened",
  "sentry:fix-refused",
  "sentry:approved-archive",
  "sentry:archived",
];

function jsonResponse(
  obj,
  { ok = true, status = 200, statusText = "OK" } = {},
) {
  return {
    ok,
    status,
    statusText,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

const BASELINE_LAST_SEEN = "2026-07-19T11:59:00.000Z";

function makeFetch({
  issue = { status: "unresolved" },
  archive = { ok: true },
  linkback = { ok: true },
  resolveShortId = { groupId: "6197137101" },
  // What the archive PUT leaves in `lastSeen`. A newer timestamp models an event
  // landing inside the mutation window; a malformed one models an unreadable
  // read-back (issue #1371). Null leaves the pre-PUT value alone.
  lastSeenAfterPut = null,
  // Another actor moves the issue off our archive between the freshness
  // read-back and the compensation's re-fetch, so restoreArchivedIssue declines
  // to clobber it and reports { restored: false }.
  concurrentMoveAfterReadBack = false,
  // The post-archive freshness GET throws (transport error / non-2xx) rather
  // than returning something unparsable.
  readbackThrows = null,
  // The compensation's restore PUT fails.
  restoreThrows = null,
  // The archive PUT lands and THEN throws — the lost-response shape.
  ambiguousArchivePut = null,
} = {}) {
  const calls = [];
  let putDone = false;
  let getsSincePut = 0;
  // Stateful: a successful PUT transitions the issue so a later GET (the
  // freshness re-check / idempotency re-check / compensation re-fetch) observes
  // the new state. Non-status fields (notably `lastSeen`) carry over. Every
  // fixture gets a parsable `lastSeen` unless it deliberately overrides one —
  // the pre-PUT baseline gate refuses an issue without it.
  let currentIssue = { lastSeen: BASELINE_LAST_SEEN, ...issue };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, headers: init.headers ?? {}, body });
    if (method === "GET" && url.includes("/shortids/")) {
      return jsonResponse(resolveShortId, {
        ok: resolveShortId?.ok !== false,
        status: resolveShortId?.ok === false ? 404 : 200,
      });
    }
    if (method === "GET" && /\/issues\/[^/]+\/$/.test(url)) {
      const snapshot = { ...currentIssue };
      if (putDone) {
        getsSincePut += 1;
        // The freshness read-back is the first GET after the PUT.
        if (readbackThrows && getsSincePut === 1) {
          throw new Error(readbackThrows);
        }
        if (concurrentMoveAfterReadBack && getsSincePut === 1) {
          currentIssue = { ...currentIssue, status: "resolved" };
          delete currentIssue.substatus;
        }
      }
      return jsonResponse(snapshot);
    }
    if (method === "PUT" && /\/issues\/[^/]+\/$/.test(url)) {
      if (putDone && restoreThrows) throw new Error(restoreThrows);
      const wasFirstPut = !putDone;
      if (archive.ok && body) {
        currentIssue = {
          ...currentIssue,
          status: body.status,
          substatus: body.substatus,
        };
        if (lastSeenAfterPut !== null) currentIssue.lastSeen = lastSeenAfterPut;
        putDone = true;
      }
      // Ambiguous success: Sentry applied the archive above, then the response
      // was lost. The caller sees a rejection it cannot distinguish from a PUT
      // that never landed.
      if (wasFirstPut && ambiguousArchivePut) {
        throw new Error(ambiguousArchivePut);
      }
      return jsonResponse(
        {},
        {
          ok: archive.ok,
          status: archive.ok ? 200 : (archive.status ?? 400),
          statusText: archive.ok ? "OK" : "Bad Request",
        },
      );
    }
    if (method === "POST" && url.includes("/comments/")) {
      if (linkback.throw) throw new Error("network down");
      return jsonResponse(
        {},
        { ok: linkback.ok, status: linkback.ok ? 201 : 500 },
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function baseOptions(overrides = {}) {
  return {
    repo: "mento-protocol/monitoring-monorepo",
    org: "mento-labs",
    sentryBaseUrl: "https://us.sentry.io",
    queueIssue: 42,
    approver: APPROVER,
    sentryToken: TOKEN,
    ...overrides,
  };
}

const FIXED_NOW = () => new Date("2026-07-19T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

await test("parseStubMetadata reads the ingest yaml fields", () => {
  const meta = parseStubMetadata(stubBody());
  assertEqual(meta.shortId, "GOVERNANCE-MENTO-ORG-51");
  assertEqual(meta.sentryIssueId, "6197137101");
  assertEqual(meta.project, "governance-mento-org");
  assertEqual(
    meta.permalink,
    "https://mento-labs.sentry.io/issues/6197137101/",
  );
});

await test("parseStubMetadata drops an unsafe permalink", () => {
  const meta = parseStubMetadata(
    stubBody({ permalink: "http://evil.example.com/phish" }),
  );
  assertEqual(meta.permalink, null);
});

await test("isSafeSentryPermalink rejects Slack/Markdown link-control chars (#1586)", () => {
  // A clean Sentry permalink stays safe.
  assertEqual(
    isSafeSentryPermalink("https://mento-labs.sentry.io/issues/6197137101/"),
    true,
  );
  // `<`, `>`, `|` would break out of a Slack `<url|text>` (or Markdown
  // `[text](url)`) link; control chars and raw whitespace are equally unsafe in
  // a link target. Built as base + char so no literal control byte lands here.
  const base = "https://mento-labs.sentry.io/issues/1";
  for (const bad of ["<", ">", "|", "\x00", "\x7f", "\n", " "]) {
    assertEqual(isSafeSentryPermalink(`${base}${bad}x`), false);
  }
});

await test("isNumericId only accepts bare digit strings", () => {
  assertEqual(isNumericId("6197137101"), true);
  assertEqual(isNumericId(""), false);
  assertEqual(isNumericId("12a"), false);
  assertEqual(isNumericId("GOV-1"), false);
});

await test("sanitizeApprover keeps a real login and falls back otherwise", () => {
  assertEqual(sanitizeApprover("octo-maintainer"), "octo-maintainer");
  assertEqual(sanitizeApprover("bad login!"), "an authorized user");
  assertEqual(sanitizeApprover("@ping"), "an authorized user");
  assertEqual(sanitizeApprover(""), "an authorized user");
});

await test("isAlreadyArchived requires the exact archived_until_escalating state", () => {
  assertEqual(
    isAlreadyArchived({
      status: "ignored",
      substatus: "archived_until_escalating",
    }),
    true,
  );
  assertEqual(
    isAlreadyArchived({
      status: "muted",
      substatus: "archived_until_escalating",
    }),
    true,
  );
  // Other archive modes are NOT the target state — they must still be PUT.
  assertEqual(
    isAlreadyArchived({ status: "ignored", substatus: "archived_forever" }),
    false,
  );
  assertEqual(
    isAlreadyArchived({
      status: "ignored",
      substatus: "archived_until_condition_met",
    }),
    false,
  );
  // Missing substatus is unconfirmed → not a settled no-op.
  assertEqual(isAlreadyArchived({ status: "ignored" }), false);
  assertEqual(isAlreadyArchived({ status: "unresolved" }), false);
  assertEqual(isAlreadyArchived({}), false);
});

await test("isActivelyRegressing flags regressed/escalating unresolved issues", () => {
  assertEqual(
    isActivelyRegressing({ status: "unresolved", substatus: "regressed" }),
    true,
  );
  assertEqual(
    isActivelyRegressing({ status: "unresolved", substatus: "escalating" }),
    true,
  );
  // Ongoing/new unresolved activity is NOT a formal regression — archivable.
  assertEqual(
    isActivelyRegressing({ status: "unresolved", substatus: "ongoing" }),
    false,
  );
  assertEqual(isActivelyRegressing({ status: "unresolved" }), false);
  // An already-archived issue is never "actively regressing".
  assertEqual(
    isActivelyRegressing({ status: "ignored", substatus: "regressed" }),
    false,
  );
});

await test("isSafeSentryPermalink requires https sentry.io", () => {
  assert(
    isSafeSentryPermalink("https://mento-labs.sentry.io/issues/1/"),
    "expected sentry.io https to be safe",
  );
  assertEqual(isSafeSentryPermalink("http://us.sentry.io/issues/1/"), false);
  assertEqual(isSafeSentryPermalink("https://evil.com/issues/1/"), false);
});

await test("buildAuditComment carries the marker, approver, action and permalink", () => {
  const body = buildAuditComment({
    approver: APPROVER,
    shortId: "GOVERNANCE-MENTO-ORG-51",
    sentryIssueId: "6197137101",
    permalink: "https://mento-labs.sentry.io/issues/6197137101/",
    timestampIso: "2026-07-19T12:00:00.000Z",
  });
  assert(body.startsWith(ARCHIVE_COMMENT_MARKER), "marker must lead the body");
  assert(body.includes("octomaintainer"), "approver must render");
  assert(body.includes("2026-07-19T12:00:00.000Z"), "timestamp must render");
  assert(
    body.includes("archived in Sentry as archived_until_escalating"),
    "archive action must render",
  );
  assert(body.includes("id 6197137101"), "sentry id must render");
  assert(
    body.includes("https://mento-labs.sentry.io/issues/6197137101/"),
    "permalink must render",
  );
});

await test("buildAuditComment defangs a hostile short id and bad approver", () => {
  const body = buildAuditComment({
    approver: "not a login",
    shortId: "`rm -rf` @channel",
    sentryIssueId: "nope",
    permalink: null,
    timestampIso: "2026-07-19T12:00:00.000Z",
    alreadyArchived: true,
  });
  assert(!body.includes("`rm -rf`"), "backticks in shortId must be defanged");
  assert(!body.includes(" @channel"), "mention must be defanged");
  assert(body.includes("an authorized user"), "bad approver falls back");
  assert(!body.includes("id nope"), "non-numeric id note is omitted");
  assert(
    body.includes("was already archived in Sentry"),
    "already-archived action text",
  );
});

await test("resolveArchiveToken reads the token from env only", () => {
  assertEqual(resolveArchiveToken({ SENTRY_ARCHIVE_TOKEN: "  tok  " }), "tok");
  assertThrows(
    () => resolveArchiveToken({}),
    /SENTRY_ARCHIVE_TOKEN is not set/,
  );
  assertThrows(
    () => resolveArchiveToken({ SENTRY_ARCHIVE_TOKEN: "   " }),
    /SENTRY_ARCHIVE_TOKEN is not set/,
  );
});

await test("ARCHIVE_PAYLOAD is archived_until_escalating, never a hard resolve", () => {
  assertDeepEqual(ARCHIVE_PAYLOAD, {
    status: "ignored",
    substatus: "archived_until_escalating",
    statusDetails: {},
  });
});

// ---------------------------------------------------------------------------
// Sentry client.
// ---------------------------------------------------------------------------

await test("resolveIssueIdFromShortId returns the numeric groupId", async () => {
  const { fetchImpl, calls } = makeFetch({ resolveShortId: { groupId: 99 } });
  const id = await resolveIssueIdFromShortId(fetchImpl, {
    baseUrl: "https://us.sentry.io",
    org: "mento-labs",
    token: TOKEN,
    shortId: "GOVERNANCE-MENTO-ORG-51",
  });
  assertEqual(id, "99");
  assert(
    calls[0].url.endsWith(
      "/organizations/mento-labs/shortids/GOVERNANCE-MENTO-ORG-51/",
    ),
    "must hit the documented shortids endpoint",
  );
});

await test("resolveIssueIdFromShortId throws on a non-numeric resolution", async () => {
  const { fetchImpl } = makeFetch({ resolveShortId: { groupId: null } });
  await assertRejects(
    resolveIssueIdFromShortId(fetchImpl, {
      baseUrl: "https://us.sentry.io",
      org: "mento-labs",
      token: TOKEN,
      shortId: "GOV-1",
    }),
    /did not resolve to a numeric issue id/,
  );
});

await test("archiveIssue PUTs the archive payload with a bearer token", async () => {
  const { fetchImpl, calls } = makeFetch();
  await archiveIssue(fetchImpl, {
    baseUrl: "https://us.sentry.io",
    org: "mento-labs",
    token: TOKEN,
    issueId: "6197137101",
  });
  const put = calls.find((c) => c.method === "PUT");
  assert(put, "a PUT must be issued");
  assert(
    put.url.endsWith("/organizations/mento-labs/issues/6197137101/"),
    "must hit the update-an-issue endpoint",
  );
  assertDeepEqual(put.body, ARCHIVE_PAYLOAD);
  assertEqual(put.headers.Authorization, `Bearer ${TOKEN}`);
});

await test("archiveIssue throws on a non-ok response", async () => {
  const { fetchImpl } = makeFetch({ archive: { ok: false, status: 403 } });
  await assertRejects(
    archiveIssue(fetchImpl, {
      baseUrl: "https://us.sentry.io",
      org: "mento-labs",
      token: TOKEN,
      issueId: "1",
    }),
    /Sentry archive request failed: 403/,
  );
});

await test("buildRestorePayload preserves status and substatus", () => {
  assertDeepEqual(buildRestorePayload({ status: "unresolved" }), {
    status: "unresolved",
  });
  assertDeepEqual(
    buildRestorePayload({ status: "ignored", substatus: "archived_forever" }),
    { status: "ignored", substatus: "archived_forever" },
  );
  // Missing status defaults to unresolved.
  assertDeepEqual(buildRestorePayload({}), { status: "unresolved" });
});

await test("restoreArchivedIssue restores only when the issue is still ours", async () => {
  // Still archived_until_escalating (what we wrote) → restore runs.
  const stillOurs = makeFetch({
    issue: { status: "ignored", substatus: "archived_until_escalating" },
  });
  const out = await restoreArchivedIssue(stillOurs.fetchImpl, {
    baseUrl: "https://us.sentry.io",
    org: "mento-labs",
    token: TOKEN,
    issueId: "9",
    preArchive: { status: "unresolved" },
  });
  assertEqual(out.restored, true);
  assertDeepEqual(stillOurs.calls.find((c) => c.method === "PUT").body, {
    status: "unresolved",
  });

  // Already moved off our archive (e.g. an operator resolved it) → no PUT.
  const moved = makeFetch({ issue: { status: "resolved" } });
  const skip = await restoreArchivedIssue(moved.fetchImpl, {
    baseUrl: "https://us.sentry.io",
    org: "mento-labs",
    token: TOKEN,
    issueId: "9",
    preArchive: { status: "unresolved" },
  });
  assertEqual(skip.restored, false);
  assert(
    !moved.calls.some((c) => c.method === "PUT"),
    "must not clobber a concurrent transition",
  );
});

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

function ghCall(calls, sub) {
  return calls.find((args) => args[0] === "issue" && args[1] === sub);
}

/** The approval-marker compare-and-swap: `gh api -X DELETE .../labels/<name>`. */
function casCall(calls) {
  return calls.find((args) => args[0] === "api" && args[2] === "DELETE");
}

/** `gh issue edit … --body <new body>` — the baseline write. */
function bodyEditCall(calls) {
  return calls.find(
    (args) =>
      args[0] === "issue" && args[1] === "edit" && args.includes("--body"),
  );
}

/** `gh issue edit … --add-label <name>` / `--remove-label <name>`. */
function labelEditCall(calls, flag = "--add-label") {
  return calls.find(
    (args) => args[0] === "issue" && args[1] === "edit" && args.includes(flag),
  );
}

/** The baseline this run wrote into the stub body, parsed back out. */
function writtenBaseline(calls) {
  const edit = bodyEditCall(calls);
  return edit ? parseArchiveBaseline(edit[edit.indexOf("--body") + 1]) : null;
}

await test("runArchive happy path archives and settles the queue stub", async () => {
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertDeepEqual(result, {
    issue: 42,
    shortId: "GOVERNANCE-MENTO-ORG-51",
    sentryIssueId: "6197137101",
    status: "archived",
  });

  // Sentry: GET status then PUT archive (no shortid resolution — id was in body).
  assert(
    !fetchCalls.some((c) => c.url.includes("/shortids/")),
    "must not resolve short-id when the numeric id is present",
  );
  const put = fetchCalls.find((c) => c.method === "PUT");
  assertDeepEqual(put.body, ARCHIVE_PAYLOAD);

  // gh: label self-heal + approval CAS + audit comment + close + terminal marker.
  assert(
    ghCalls.some((a) => a[0] === "label" && a[1] === "create"),
    "labels are self-healed",
  );
  const cas = casCall(ghCalls);
  assert(cas, "the approval marker is consumed via an observable DELETE");
  assertEqual(
    cas[3],
    "repos/mento-protocol/monitoring-monorepo/issues/42/labels/sentry:approved-archive",
  );
  const comment = ghCall(ghCalls, "comment");
  assert(comment, "audit comment posted");
  assert(
    comment[comment.indexOf("--body") + 1].includes(ARCHIVE_COMMENT_MARKER),
    "audit comment carries the marker",
  );
  const bodyEdit = bodyEditCall(ghCalls);
  assert(bodyEdit, "the freshness baseline is written into the stub body");
  const edit = labelEditCall(ghCalls);
  assertEqual(edit[edit.indexOf("--add-label") + 1], "sentry:archived");
  assert(
    !edit.includes("--remove-label"),
    "the approval marker is consumed by the CAS, not by the label edit",
  );
  const close = ghCall(ghCalls, "close");
  assertEqual(close[close.indexOf("--reason") + 1], "completed");

  // Ordering is the whole point of the CAS: consume the approval BEFORE the
  // close, so a reopen that lands in the window loses the race observably.
  assert(
    ghCalls.indexOf(cas) < ghCalls.indexOf(close),
    "the CAS must precede the close",
  );
  // And the baseline must land before anything marks the stub settled, or a
  // crash between them leaves a closed+archived stub ingest cannot read.
  assert(
    ghCalls.indexOf(bodyEdit) < ghCalls.indexOf(close) &&
      ghCalls.indexOf(bodyEdit) < ghCalls.indexOf(edit),
    "the baseline write must precede the close and the terminal marker",
  );

  // The Sentry token must never appear in a gh argument.
  assert(
    !ghCalls.some((args) => args.some((a) => String(a).includes(TOKEN))),
    "the Sentry token must never reach a gh call",
  );
});

await test("runArchive is idempotent when the issue is already archived", async () => {
  const stub = makeStub({ body: settledStubBody() });
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: { status: "ignored", substatus: "archived_until_escalating" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "already-archived");
  assert(
    !fetchCalls.some((c) => c.method === "PUT"),
    "no PUT when already archived_until_escalating",
  );
  // No duplicate Sentry link-back note on the retry path (posted only after a
  // fresh archive).
  assert(
    !fetchCalls.some((c) => c.method === "POST"),
    "no link-back note when already archived (retry idempotency)",
  );
  // Still settles the queue stub.
  assert(ghCall(ghCalls, "comment"), "audit comment still posted");
  assert(ghCall(ghCalls, "close"), "stub still closed");
});

await test("runArchive refuses and re-queues a live regression instead of archiving over it", async () => {
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: { status: "unresolved", substatus: "regressed" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-regressed");
  assert(
    !fetchCalls.some((c) => c.method === "PUT"),
    "a live regression must not be archived",
  );
  assert(!ghCall(ghCalls, "close"), "must not close over the regression");
  assert(ghCall(ghCalls, "comment"), "posts a refusal comment");
  const edit = ghCall(ghCalls, "edit");
  assert(edit, "re-queues via a label edit");
  assertEqual(edit[edit.indexOf("--add-label") + 1], "sentry:needs-triage");
  const removed = edit[edit.indexOf("--remove-label") + 1];
  assert(
    removed.includes("sentry:approved-archive") &&
      removed.includes("sentry:verdict-upstream"),
    "sheds the approval + verdict labels",
  );
  // Already open, so there is nothing to reopen.
  assert(!ghCall(ghCalls, "reopen"), "an open stub is left alone");
});

await test("a live regression on a CLOSED stub reopens it", async () => {
  // Stage B closes a verdicted stub, then a human applies the approval to that
  // closed stub. Re-queuing alone leaves it CLOSED wearing sentry:needs-triage:
  // the triage selector filters on --state open, and ingest skips a closed stub
  // whenever this occurrence's lastSeen is not newer than the later closedAt. A
  // regression we KNOW is live would sit there, seen by nothing.
  const stub = makeStub({ state: "CLOSED" });
  const { runGh, calls: ghCalls, model } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: { status: "unresolved", substatus: "regressed" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-regressed");
  assert(!fetchCalls.some((c) => c.method === "PUT"), "nothing is archived");
  // The observable end state is the point: open AND needing triage, which is
  // exactly the pair the selector looks for.
  assertEqual(model.state, "OPEN");
  assert(model.labels.includes("sentry:needs-triage"));
  assertEqual(model.labels.includes("sentry:approved-archive"), false);
  assertEqual(model.labels.includes("sentry:verdict-upstream"), false);
  // Ordering: the state change goes last, so a failed label edit leaves the stub
  // closed and retryable rather than open without sentry:needs-triage.
  const edit = ghCall(ghCalls, "edit");
  const reopen = ghCall(ghCalls, "reopen");
  assert(reopen, "the closed stub is reopened");
  assert(
    ghCalls.indexOf(edit) < ghCalls.indexOf(reopen),
    "labels before the reopen",
  );
});

await test("a failed read cannot abort the live-regression reopen", async () => {
  // The label edit has already landed by this point, so bailing out on a
  // transient read leaves exactly the invisible stub the reopen exists to
  // prevent — closed, needs-triage, approval and verdict shed — and past the
  // point the caller's reconciler can help, since settlement never ran and it
  // holds no target. The read may only refine the decision, never skip it.
  const stub = makeStub({ state: "CLOSED" });
  let views = 0;
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        views += 1;
        // View 1 is runArchive's read; view 2 is the reopen's re-read.
        if (views === 2) return "gh issue view failed: HTTP 500";
      }
      return null;
    },
  });
  const { fetchImpl } = makeFetch({
    issue: { status: "unresolved", substatus: "regressed" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-regressed");
  assertEqual(
    model.state,
    "OPEN",
    "the transition happens off the pre-run observation when the read fails",
  );
  assert(model.labels.includes("sentry:needs-triage"));
});

await test("isSelectableForTriage is exactly Stage B's selector pair", () => {
  const ok = {
    state: "OPEN",
    labels: ["sentry-triage", "sentry:needs-triage"],
  };
  assertEqual(isSelectableForTriage(ok), true);
  assertEqual(isSelectableForTriage({ ...ok, state: "CLOSED" }), false);
  assertEqual(
    isSelectableForTriage({ ...ok, labels: ["sentry-triage"] }),
    false,
  );
  assertEqual(isSelectableForTriage({}), false);
  assertEqual(isSelectableForTriage(), false);
});

await test("a failing refusal comment cannot abort the state transition", async () => {
  // The comment is cosmetic. Letting it throw skipped the label swap AND the
  // verifier, leaving a closed stub with its stale approval and verdict — and
  // ingest keeps skipping it because the sticky regression predates closedAt.
  // A guard that only runs on the happy path guards nothing.
  const stub = makeStub({ state: "CLOSED" });
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "comment" ? "gh issue comment: HTTP 500" : null,
  });
  const { fetchImpl } = makeFetch({
    issue: { status: "unresolved", substatus: "regressed" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-regressed");
  assertEqual(model.state, "OPEN");
  assert(model.labels.includes("sentry:needs-triage"));
  assertEqual(model.labels.includes("sentry:approved-archive"), false);
  assertEqual(model.labels.includes("sentry:verdict-upstream"), false);
});

await test("a failing re-queue label edit still reaches the verifier, then fails RED", async () => {
  // The label edit throwing skipped the verifier entirely. Now it is recorded
  // and execution continues: the verifier drives the stub to selectable — it
  // re-adds needs-triage itself — and only then does the run go RED for the
  // markers it could not shed. Safe first, loud second.
  const stub = makeStub({ state: "CLOSED" });
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "edit" && args.includes("--remove-label")
        ? "gh issue edit: HTTP 500"
        : null,
  });
  const { fetchImpl } = makeFetch({
    issue: { status: "unresolved", substatus: "regressed" },
  });

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /shedding its stale approval\/verdict markers failed/,
  );

  // The stub is selectable despite the failed edit — that is the placement fix.
  assertEqual(model.state, "OPEN");
  assert(
    model.labels.includes("sentry:needs-triage"),
    "the verifier re-added the label the failed edit never applied",
  );
  // And the RED run names what is still wrong.
  assert(
    model.labels.includes("sentry:approved-archive"),
    "the stale markers really did survive, which is why the run is red",
  );
});

await test("a genuinely failing reopen strands the stub and fails RED", async () => {
  // The third failure layer at this spot: the label edit has already stripped
  // approval, verdict and archive markers and added needs-triage, so a closed
  // stub here is invisible to Stage B (open-only selector) and to ingest (its
  // closedAt postdates the sticky regression). Checking the END state catches
  // this without anyone having predicted a failing reopen WRITE specifically.
  const stub = makeStub({ state: "CLOSED" });
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "reopen" ? "gh issue reopen: HTTP 500" : null,
  });
  const { fetchImpl } = makeFetch({
    issue: { status: "unresolved", substatus: "regressed" },
  });
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await assertRejects(
      runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
      /not selectable for triage/,
    );
  } finally {
    process.stderr.write = write;
  }

  assertEqual(model.state, "CLOSED", "the stub really is stranded");
  const errorLine = stderr.find((l) => l.includes("::error::"));
  assert(errorLine, "a stranded stub must be loud");
  assert(errorLine.includes("STRANDED"), "says the stub is stranded");
  assert(errorLine.includes("state=CLOSED"), "names the observed state");
  assert(
    errorLine.includes("Reopen it by hand"),
    "tells the operator what to do",
  );
});

await test("a reopen that fails once is retried and converges", async () => {
  // The retry is the cheap part; the verification is what makes it safe to stop.
  const stub = makeStub({ state: "CLOSED" });
  let reopens = 0;
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) => {
      if (args[1] === "reopen") {
        reopens += 1;
        if (reopens === 1) return "gh issue reopen: connection reset";
      }
      return null;
    },
  });
  const { fetchImpl } = makeFetch({
    issue: { status: "unresolved", substatus: "regressed" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-regressed");
  assertEqual(model.state, "OPEN");
  assert(model.labels.includes("sentry:needs-triage"));
  assertEqual(
    reopens,
    2,
    "it retried rather than failing on the first refusal",
  );
});

await test("a needs-triage label stripped mid-flight is restored", async () => {
  // The invariant is the PAIR. A concurrent actor removing the label between the
  // edit and the verification leaves an open stub Stage B still cannot see, so
  // driving only the state would not be enough.
  const stub = makeStub({ state: "CLOSED" });
  let stripped = false;
  const { runGh, model } = makeRunGh({
    stub,
    beforeCall: (args) => {
      if (!stripped && args[1] === "reopen") {
        model.labels = model.labels.filter((n) => n !== "sentry:needs-triage");
        stripped = true;
      }
    },
  });
  const { fetchImpl } = makeFetch({
    issue: { status: "unresolved", substatus: "regressed" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-regressed");
  assertEqual(model.state, "OPEN");
  assert(
    model.labels.includes("sentry:needs-triage"),
    "the label is put back so the pair holds",
  );
});

await test("the settlement body write rebases onto the live body", async () => {
  // gh issue edit --body replaces the WHOLE body, so building it from the
  // pre-CAS snapshot silently deletes an authorised edit made since that read —
  // and the post-settlement verification only checks the baseline, so it cannot
  // see the loss. Round 12 fixed this on the rollback path; this is its sibling.
  const stub = makeStub();
  const edited = stubBody({
    permalink: "https://mento-labs.sentry.io/issues/6197137101/?edited=1",
  });
  const { runGh, model } = makeRunGh({
    stub,
    beforeCall: (args) => {
      // A human edits the body between the pre-CAS read and the body write.
      if (args[0] === "api" && args[2] === "DELETE") model.body = edited;
    },
  });
  const { fetchImpl } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "archived");
  assert(
    model.body.includes("?edited=1"),
    "the concurrent edit survives the settlement write",
  );
  assertEqual(
    parseArchiveBaseline(model.body).lastSeen,
    BASELINE_LAST_SEEN,
    "and the baseline is still recorded on top of it",
  );
});

await test("runArchive re-archives an issue in a different archive mode", async () => {
  // Archived_forever (or any non-escalating mode) must still get the corrective
  // PUT so the escalation-reopen safety loop holds.
  const stub = makeStub();
  const { runGh } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: { status: "ignored", substatus: "archived_forever" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "archived");
  const put = fetchCalls.find((c) => c.method === "PUT");
  assert(put, "a corrective PUT must be issued");
  assertDeepEqual(put.body, ARCHIVE_PAYLOAD);
});

await test("runArchive resolves the short-id when the stub lacks a numeric id", async () => {
  const stub = makeStub({ body: stubBody({ sentryIssueId: "" }) });
  const { runGh } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    resolveShortId: { groupId: "424242" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.sentryIssueId, "424242");
  assert(
    fetchCalls.some((c) => c.url.includes("/shortids/")),
    "short-id resolution must run",
  );
  const put = fetchCalls.find((c) => c.method === "PUT");
  assert(
    put.url.endsWith("/issues/424242/"),
    "archive must target the resolved id",
  );
});

await test("runArchive throws when the stub has no short_id, touching nothing", async () => {
  const stub = makeStub({ body: stubBody({ shortId: "" }) });
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch();
  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /no parseable Sentry short_id/,
  );
  // The observable property, not just the throw: this bails before any mutation,
  // so there is nothing to compensate and nothing must have been written.
  assert(!fetchCalls.some((c) => c.method === "PUT"), "no Sentry mutation");
  assert(!casCall(ghCalls), "the approval is untouched");
  assert(!ghCall(ghCalls, "close"), "the stub is untouched");
  assert(!ghCall(ghCalls, "edit"), "no body or label write");
});

await test("runArchive refuses (no mutation) when approval/verdict labels were shed", async () => {
  // Simulate a concurrent regression-reopen that sheds the approval + verdict
  // labels between the workflow guard and this run: the live stub now reads as
  // awaiting fresh triage. Nothing may be archived off the stale approval.
  const stub = makeStub();
  stub.labels = [{ name: "sentry-triage" }, { name: "sentry:needs-triage" }];
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-state");
  assert(
    !fetchCalls.some((c) => c.method === "PUT"),
    "no Sentry archive when the approval was revoked",
  );
  assert(!ghCall(ghCalls, "close"), "no queue close");
  assert(!ghCall(ghCalls, "comment"), "no audit comment");
  assert(!ghCall(ghCalls, "edit"), "no label swap");
});

await test("stubIsArchivable requires triage + approval + a verdict label", () => {
  assert(
    stubIsArchivable([
      "sentry-triage",
      "sentry:approved-archive",
      "sentry:verdict-upstream",
    ]),
    "full set is archivable",
  );
  assertEqual(
    stubIsArchivable(["sentry-triage", "sentry:needs-triage"]),
    false,
  );
  assertEqual(
    stubIsArchivable(["sentry-triage", "sentry:approved-archive"]),
    false,
  );
  assertEqual(stubIsArchivable([]), false);
});

await test("a mid-flight reopen rolls back the queue and leaves Sentry archived", async () => {
  // Labels are valid at the pre-mutation read (so Sentry IS archived), but a
  // regression reopen sheds them before settlement. The reopened stub must NOT
  // be closed/relabeled off the stale approval. Sentry KEEPS the archive: it is
  // archived_until_escalating, which is exactly what the human approved and what
  // escalation undoes by itself (ADR 0036). Reverting it would race Sentry's own
  // transition and could erase a fresh `regressed` substatus.
  const stub = makeStub();
  // Ingest's reopen lands just before settlement's pre-CAS read (view 2).
  const {
    runGh,
    calls: ghCalls,
    model,
  } = makeRunGh({
    stub,
    concurrentReopenBeforeView: 2,
  });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "unsettled-reopened");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 1, "the archive stands; nothing reverts it");
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  assert(!ghCall(ghCalls, "close"), "reopened stub must not be closed");
  assert(
    !labelEditCall(ghCalls, "--add-label"),
    "reopened stub must not gain sentry:archived",
  );
  assert(!ghCall(ghCalls, "comment"), "no audit comment on the reopened stub");
  // Sentry may be archived, so the approval is spent no matter how far this got.
  assertEqual(model.labels.includes("sentry:approved-archive"), false);
});

await test("a mid-flight reopen does not undo a corrective re-archive", async () => {
  // The issue was archived_forever before this run, so the run re-archived it to
  // until-escalating — the mode the escalation-reopen safety loop needs. A
  // mid-flight reopen must NOT put it back to archived_forever: that would
  // restore the indefinite archive this pipeline exists to correct.
  const stub = makeStub();
  const { runGh } = makeRunGh({ stub, concurrentReopenBeforeView: 2 });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: { status: "ignored", substatus: "archived_forever" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "unsettled-reopened");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 1);
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
});

await test("runArchive does not revert when the issue was already archived before the run", async () => {
  // If the issue was ALREADY archived_until_escalating (we issued no PUT) and
  // the stub is reopened mid-flight, there is nothing we archived to undo.
  const stub = makeStub({ body: settledStubBody() });
  const { runGh } = makeRunGh({ stub, concurrentReopenBeforeView: 2 });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: { status: "ignored", substatus: "archived_until_escalating" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "unsettled-reopened");
  assert(
    !fetchCalls.some((c) => c.method === "PUT"),
    "no Sentry mutation (nothing to archive or revert)",
  );
});

await test("runArchive refuses when the verdict label is missing", async () => {
  const stub = makeStub();
  stub.labels = [
    { name: "sentry-triage" },
    { name: "sentry:approved-archive" },
  ];
  const { runGh } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch();
  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });
  assertEqual(result.status, "skipped-state");
  assert(!fetchCalls.some((c) => c.method === "PUT"), "no Sentry mutation");
});

await test("runArchive tolerates a thrown link-back and still succeeds", async () => {
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({ linkback: { throw: true } });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });
  assertEqual(result.status, "archived");
  assert(
    ghCall(ghCalls, "close"),
    "stub still closed despite link-back failure",
  );
});

await test("runArchive tolerates a non-ok link-back response", async () => {
  const stub = makeStub();
  const { runGh } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({ linkback: { ok: false } });
  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });
  assertEqual(result.status, "archived");
});

await test("a failed close leaves the stub open without approval or archived markers", async () => {
  // The CAS consumes sentry:approved-archive before the close, so a transient
  // close failure can no longer be retried via workflow_dispatch (its guard
  // needs that label). The property that survives: the stub is left OPEN with
  // neither the approval marker (nothing re-triggers the labeled workflow) nor
  // sentry:archived, so the next ingest/triage cycle handles it normally — and
  // the archive this run made is compensated, so Sentry is not left archived
  // off an approval nobody can spend again.
  const stub = makeStub();
  const { runGh, calls, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "close" ? "gh issue close failed: HTTP 500" : null,
  });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /close failed/,
  );

  assert(casCall(calls), "the approval marker was consumed before the close");
  // Convergence is a question about FINAL state, not the call sequence.
  assertEqual(model.state, "OPEN");
  assertEqual(model.labels.includes("sentry:archived"), false);
  assertEqual(model.labels.includes("sentry:approved-archive"), false);
  assertEqual(parseArchiveBaseline(model.body), null, "baseline rolled back");
  assertEqual(
    fetchCalls.filter((c) => c.method === "PUT").length,
    1,
    "Sentry keeps the approved archive",
  );
});

await test("a settlement failure rolls back the queue and leaves Sentry archived", async () => {
  // The sharpest post-CAS partial commit: the close SUCCEEDS and the terminal
  // sentry:archived edit then fails. Ingest only reads this stub's audit
  // baseline when the stub carries sentry:archived, so an uncompensated failure
  // here would leave a CLOSED, archived-in-Sentry stub whose baseline nothing
  // reads — sending the reopen gate back to the closedAt comparison and burying
  // any event that landed in the archive window (issue #1371). BOTH sides must
  // be undone — Sentry AND the queue — and the run must still fail RED.
  const stub = makeStub();
  const { runGh, calls, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "edit" && args.includes("--add-label")
        ? "gh issue edit failed: HTTP 502"
        : null,
  });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /HTTP 502/,
  );

  assert(casCall(calls), "the CAS won before the failing step");
  assert(ghCall(calls, "close"), "the close ran before the failing step");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 1, "the approved archive stands");
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  // The stub must not sit CLOSED without sentry:archived — precisely the shape
  // ingest cannot read a baseline from.
  assertEqual(model.state, "OPEN");
  assertEqual(model.labels.includes("sentry:archived"), false);
  assertEqual(parseArchiveBaseline(model.body), null, "baseline rolled back");
});

await test("settlementHeld requires closed + queue marker + verdict + archived", () => {
  const settled = {
    state: "CLOSED",
    labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:archived"],
  };
  assertEqual(settlementHeld(settled), true);
  // Each signal alone catches a concurrent reopen, whichever order the two runs
  // interleaved: ingest flips the state, sheds the verdict AND sheds archived.
  assertEqual(settlementHeld({ ...settled, state: "OPEN" }), false);
  assertEqual(
    settlementHeld({
      ...settled,
      labels: ["sentry-triage", "sentry:archived"],
    }),
    false,
  );
  assertEqual(
    settlementHeld({
      ...settled,
      labels: ["sentry-triage", "sentry:verdict-upstream"],
    }),
    false,
  );
  assertEqual(settlementHeld({}), false);
  assertEqual(settlementHeld(), false);
});

await test("a reopen that lands after the CAS undoes the queue settlement", async () => {
  // Winning the CAS buys exclusivity on the APPROVAL, not on the stub. Ingest's
  // reopen sheds sentry:approved-archive with a --remove-label that simply
  // no-ops once we took it, so its whole sequence can still complete inside the
  // settlement window. Without the post-settlement read this returns settled,
  // and sentry:archived lands on a stub ingest just reopened for a live
  // regression — with Sentry left archived.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    // Views: 1 runArchive's read, 2 settlement's pre-CAS read, 3 the body-write
    // rebase read, 4 the post-settlement verification. Land ingest's whole
    // reopen just before that verification, which is the read that must catch it.
    concurrentReopenBeforeView: 4,
  });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "unsettled-reopened");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 1, "Sentry keeps the archive");
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  // The queue converges on what ingest wanted: open, needing triage, with
  // no terminal marker and no baseline describing an archive that was undone.
  assertEqual(model.state, "OPEN");
  assertEqual(model.labels.includes("sentry:archived"), false);
  assert(
    model.labels.includes("sentry:needs-triage"),
    "ingest's reopen stands",
  );
  assertEqual(parseArchiveBaseline(model.body), null, "baseline rolled back");
});

// ---------------------------------------------------------------------------
// Ambiguous success: the mutation LANDS and the response is lost. Every
// did-we-do-it flag is wrong here, which is why rollback reconciles against
// live state instead of replaying a log of what we believe we did.
// ---------------------------------------------------------------------------

await test("a lost response on the close still converges", async () => {
  // `gh issue close` closes the stub, then the connection drops. A
  // closedByThisRun flag is never set, so flag-based repair skipped the reopen
  // and left a CLOSED stub with no sentry:archived — silently back on the
  // closedAt fallback, and not even visibly stranded.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    ambiguousOn: (args) =>
      args[1] === "close" ? "gh issue close: connection reset" : null,
  });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /connection reset/,
  );

  assertEqual(model.state, "OPEN", "the landed close is observed and undone");
  assertEqual(model.labels.includes("sentry:archived"), false);
  assertEqual(parseArchiveBaseline(model.body), null);
  assertEqual(
    fetchCalls.filter((c) => c.method === "PUT").length,
    1,
    "Sentry keeps the approved archive",
  );
});

await test("a lost response on the archive PUT still converges", async () => {
  // Sentry archives the issue, then the response is lost. The PUT used to sit
  // outside the compensating scope entirely, so nothing ran: the issue stayed
  // archived with the approval still spendable, and a dispatch retry took the
  // alreadyArchived path and re-baselined off retry-time lastSeen.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    ambiguousArchivePut: "Sentry archive request: socket hang up",
  });

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /socket hang up/,
  );

  // The archive landed and stays landed — archived_until_escalating is the
  // approved outcome, so a lost response on the PUT needs no Sentry repair.
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 1);
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  // Settlement never started, so the stub is untouched apart from the disarm.
  assertEqual(model.state, "OPEN");
  // A lost response means Sentry MAY hold the archive, so the approval must not
  // stay spendable — a retry would take the already-archived path and stamp its
  // own read time. This is the hoisted rule reaching a path that never got
  // anywhere near settlement.
  assertEqual(model.labels.includes("sentry:approved-archive"), false);
});

await test("a lost response on the terminal label still converges", async () => {
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    ambiguousOn: (args) =>
      args[1] === "edit" && args.includes("--add-label")
        ? "gh issue edit: gateway timeout"
        : null,
  });
  const { fetchImpl } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /gateway timeout/,
  );

  // Both the landed label AND the landed close are observed and undone.
  assertEqual(model.labels.includes("sentry:archived"), false);
  assertEqual(model.state, "OPEN");
  assertEqual(parseArchiveBaseline(model.body), null);
});

await test("a lost response on the body edit still converges", async () => {
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    ambiguousOn: (args) =>
      args[1] === "edit" && args.includes("--body")
        ? "gh issue edit: connection reset"
        : null,
  });
  const { fetchImpl } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /connection reset/,
  );

  // The baseline landed; it must not survive a rolled-back archive, or the next
  // run compares a live regression against a timestamp nothing stands behind.
  assertEqual(parseArchiveBaseline(model.body), null);
  assertEqual(model.body, stub.body);
  assertEqual(model.state, "OPEN");
});

await test("a failed settlement restores the PREVIOUS baseline, not just any baseline", async () => {
  // A re-approved stub already carries a baseline from its earlier archive.
  // Restoring only when the target had NONE left the failed run's newer
  // timestamp in place — and on a stub still carrying sentry:archived, ingest
  // trusts that timestamp and skips any regression predating it.
  const previous = "2026-07-01T00:00:00.000Z";
  const stub = makeStub({
    body: withArchiveBaseline(stubBody(), {
      lastSeen: previous,
      sentryIssueId: "6197137101",
    }),
  });
  stub.labels.push({ name: "sentry:archived" });
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "close" ? "gh issue close failed: HTTP 500" : null,
  });
  const { fetchImpl } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /close failed/,
  );

  const landed = parseArchiveBaseline(model.body);
  assert(landed, "the stub keeps a baseline — it was archived before");
  assertEqual(
    landed.lastSeen,
    previous,
    "the PREVIOUS baseline is restored, not the failed run's newer one",
  );
});

await test("a failed settlement leaves no audit comment claiming an archive", async () => {
  // Ordering, not compensation: the note goes last. A comment that landed
  // before a failing close would claim the issue was archived, and a later
  // successful re-approval would see the marker, suppress the real audit, and
  // leave the durable record showing the FAILED attempt's approver and baseline.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "close" ? "gh issue close failed: HTTP 500" : null,
  });
  const { fetchImpl } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /close failed/,
  );

  assertEqual(
    model.comments.filter((c) => c.body.includes(ARCHIVE_COMMENT_MARKER))
      .length,
    0,
    "no audit note may survive a settlement that did not happen",
  );
});

await test("the audit note lands only after the settlement has converged", async () => {
  const stub = makeStub();
  const { runGh, calls, model } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch();

  await runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW });

  const commentIdx = calls.findIndex(
    (a) => a[0] === "issue" && a[1] === "comment",
  );
  const closeIdx = calls.findIndex((a) => a[0] === "issue" && a[1] === "close");
  const labelIdx = calls.findIndex(
    (a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label"),
  );
  assert(commentIdx > closeIdx, "the note follows the close");
  assert(commentIdx > labelIdx, "the note follows the terminal marker");
  assertEqual(
    model.comments.filter((c) => c.body.includes(ARCHIVE_COMMENT_MARKER))
      .length,
    1,
    "exactly one audit note on a settled stub",
  );
});

await test("a failed audit note does not roll back a converged settlement", async () => {
  // The settlement is already correct and verified; the note is the only
  // human-facing part and the machine record is in the body. Undoing a
  // legitimate archive over a failed comment would be strictly worse.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "comment" ? "gh issue comment failed: HTTP 500" : null,
  });
  const { fetchImpl } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "archived");
  assertEqual(model.state, "CLOSED", "the settlement stands");
  assert(model.labels.includes("sentry:archived"));
  assert(parseArchiveBaseline(model.body), "the machine record survives");
});

await test("a quiet retry over an existing archive is a no-op on the baseline", async () => {
  // Queue-only rollback leaves Sentry archived and the runbook says re-approve,
  // so this is the NORMAL recovery. When nothing new landed, Sentry's lastSeen
  // still equals the recorded baseline, so settling again re-stamps the same
  // value and the audit note dedups. The dangerous case — lastSeen having moved
  // — is the refusal below; this pins that the quiet case stays inert.
  const recorded = "2026-07-19T11:59:00.000Z";
  const stub = makeStub({
    state: "CLOSED",
    comments: [auditComment({ baselineLastSeen: recorded })],
    body: withArchiveBaseline(stubBody(), {
      lastSeen: recorded,
      sentryIssueId: "6197137101",
    }),
  });
  stub.labels.push({ name: "sentry:archived" });
  const { runGh, model } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({
    issue: {
      status: "ignored",
      substatus: "archived_until_escalating",
      lastSeen: recorded,
    },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "already-archived");
  assertEqual(parseArchiveBaseline(model.body).lastSeen, recorded);
  assertEqual(
    model.comments.filter((c) => c.body.includes(ARCHIVE_COMMENT_MARKER))
      .length,
    1,
    "the retry adds no second audit note for the same archive",
  );
});

await test("a retry refuses when the stub records NO bound baseline", async () => {
  // The complement of the stale check. A run can archive Sentry and then fail
  // before writing the body baseline; rollback deliberately leaves none, and the
  // runbook permits re-approving. On that retry there is nothing to compare
  // against, and adopting the retry's own read would absorb everything that
  // arrived between the first archive and the re-approval — which ingest never
  // reopens for, because it cannot see an archived issue at all.
  const stub = makeStub({ state: "CLOSED" }); // default body: no baseline
  stub.labels.push({ name: "sentry:archived" });
  const { runGh, calls, model } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: {
      status: "ignored",
      substatus: "archived_until_escalating",
      lastSeen: "2026-07-19T12:30:00.000Z",
    },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-unbaselined-retry");
  assert(!fetchCalls.some((c) => c.method === "PUT"), "no Sentry mutation");
  assert(!bodyEditCall(calls), "no baseline is invented from this run's read");
  assertEqual(parseArchiveBaseline(model.body), null);
  assert(!ghCall(calls, "close"), "the ledger is not settled");
  const comment = ghCall(calls, "comment");
  assert(comment, "the refusal is written where an operator will see it");
  assert(
    comment[comment.indexOf("--body") + 1].includes(
      "records no freshness baseline",
    ),
    "and names the missing baseline",
  );
  // The shared post-condition disarms: Sentry may be archived, so no bare
  // re-dispatch may walk back in.
  assertEqual(model.labels.includes("sentry:approved-archive"), false);
});

await test("an unusable or foreign baseline counts as absent", async () => {
  // "Bound" means all three: present, a real date, and naming THIS issue. A
  // baseline failing any of them is not evidence about this archive, so it must
  // refuse exactly as a missing one does — otherwise the stale comparison runs
  // against a value it cannot trust and silently passes.
  const refuseWith = async (body) => {
    const stub = makeStub({ state: "CLOSED", body });
    stub.labels.push({ name: "sentry:archived" });
    const { runGh } = makeRunGh({ stub });
    const { fetchImpl } = makeFetch({
      issue: { status: "ignored", substatus: "archived_until_escalating" },
    });
    const result = await runArchive(baseOptions(), {
      runGh,
      fetchImpl,
      now: FIXED_NOW,
    });
    return result.status;
  };

  assertEqual(
    await refuseWith(
      withArchiveBaseline(stubBody(), {
        lastSeen: BASELINE_LAST_SEEN,
        sentryIssueId: "999",
      }),
    ),
    "skipped-unbaselined-retry",
    "another issue's baseline is not this issue's evidence",
  );
  assertEqual(
    await refuseWith(
      withArchiveBaseline(stubBody(), {
        lastSeen: "not-a-date",
        sentryIssueId: "6197137101",
      }),
    ),
    "skipped-unbaselined-retry",
    "an unparsable timestamp cannot be compared against",
  );
});

await test("a retry refuses outright when Sentry moved past the recorded baseline", async () => {
  // Positive evidence of an untriaged event. Stamping the newer timestamp would
  // bury it: an archived issue matches neither ingest query, so nothing would
  // ever reopen the stub for it.
  const recorded = "2026-07-19T11:59:00.000Z";
  const stub = makeStub({
    state: "CLOSED",
    body: withArchiveBaseline(stubBody(), {
      lastSeen: recorded,
      sentryIssueId: "6197137101",
    }),
  });
  stub.labels.push({ name: "sentry:archived" });
  const { runGh, calls, model } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: {
      status: "ignored",
      substatus: "archived_until_escalating",
      lastSeen: "2026-07-19T12:30:00.000Z",
    },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "skipped-stale-retry");
  assert(!fetchCalls.some((c) => c.method === "PUT"), "no Sentry mutation");
  assert(!bodyEditCall(calls), "the baseline is not re-stamped");
  assertEqual(
    parseArchiveBaseline(model.body).lastSeen,
    recorded,
    "the recorded baseline survives untouched",
  );
  // Visible to a human, and disarmed against a bare re-dispatch.
  const comment = ghCall(calls, "comment");
  assert(comment, "the refusal is written where an operator will see it");
  const body = comment[comment.indexOf("--body") + 1];
  assert(body.includes("Not archived."), "says plainly nothing was archived");
  // …and points somewhere that actually works. Telling the operator to
  // re-approve loops: the baseline is still older and the issue still archived,
  // so the same guard refuses again and removes the label again.
  assert(
    body.includes("Re-applying it will refuse again"),
    "names the loop instead of sending the operator into it",
  );
  assert(
    body.includes("Un-archive the Sentry issue"),
    "and gives the exit that works",
  );
  assertEqual(model.labels.includes("sentry:approved-archive"), false);
});

await test("a re-archive after a regression posts its own audit note", async () => {
  // The stub was archived, regressed, reopened by ingest (comments survive),
  // re-triaged and re-approved. Keying dedup on the Sentry issue id alone made
  // the previous archive's note suppress this one, losing the new approver,
  // timestamp and disposition.
  const stalePreviousArchive = auditComment({
    baselineLastSeen: "2026-07-01T00:00:00.000Z",
  });
  const stub = makeStub({ comments: [stalePreviousArchive] });
  const { runGh, calls, model } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch();

  await runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW });

  const notes = model.comments.filter((c) =>
    c.body.includes(ARCHIVE_COMMENT_MARKER),
  );
  assertEqual(notes.length, 2, "the new archive records its own audit");
  const posted = ghCall(calls, "comment");
  assert(posted, "a note was posted despite the older marker");
  assert(
    posted[posted.indexOf("--body") + 1].includes(BASELINE_LAST_SEEN),
    "and it carries THIS archive's baseline",
  );
});

await test("a lost response on a correction converges instead of failing red", async () => {
  // The corrective write is accepted and its response lost — the same ambiguity
  // the reconciler exists for. Deciding `converged` in the catch turned a
  // successful recovery into a red run telling the operator to repair by hand.
  const stub = makeStub();
  const { runGh } = makeRunGh({
    stub,
    ambiguousOn: (args) =>
      args[1] === "close"
        ? "gh issue close: connection reset"
        : args[1] === "reopen"
          ? "gh issue reopen: connection reset"
          : null,
  });
  const { fetchImpl } = makeFetch();
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await assertRejects(
      runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
      /connection reset/,
    );
  } finally {
    process.stderr.write = write;
  }

  assert(
    !stderr.some((l) => l.includes("did NOT converge")),
    "the verification read disproves the reported correction failure",
  );
  assert(
    stderr.some((l) => l.includes("the verification read disproved")),
    "and the discrepancy is still logged",
  );
});

await test("baseline rollback preserves a concurrent body edit", async () => {
  // The correction rebuilds only the two baseline fields on top of the LIVE
  // body. Writing back the whole snapshot erased any unrelated edit made after
  // it — silent data loss, in the very code that was careful not to cause it.
  const stub = makeStub();
  const edited = stubBody({
    permalink: "https://mento-labs.sentry.io/issues/6197137101/?edited=1",
  });
  const { runGh, model } = makeRunGh({
    stub,
    // A human edits the body between the settlement's write and the rollback.
    beforeCall: (args) => {
      if (args[0] === "issue" && args[1] === "close") {
        model.body = withArchiveBaseline(edited, {
          lastSeen: BASELINE_LAST_SEEN,
          sentryIssueId: "6197137101",
        });
      }
    },
    failOn: (args) =>
      args[1] === "close" ? "gh issue close failed: HTTP 500" : null,
  });
  const { fetchImpl } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /close failed/,
  );

  assertEqual(parseArchiveBaseline(model.body), null, "the baseline is undone");
  assert(
    model.body.includes("?edited=1"),
    "the concurrent edit survives the rollback",
  );
});

await test("a rejected archive PUT is never summarised as archived", async () => {
  // The runbook tells operators to trust the summary line. Asserting a
  // successful archive on a run whose PUT Sentry refused is worse than silence.
  assertEqual(
    describeSentryDisposition("confirmed", "9").includes(
      "stays archived_until_escalating",
    ),
    true,
  );
  assertEqual(
    describeSentryDisposition("pre-existing", "9").includes(
      "stays archived_until_escalating",
    ),
    true,
  );
  const rejected = describeSentryDisposition("rejected", "9");
  assert(rejected.includes("was NOT archived"), "a refusal says so");
  assert(!rejected.includes("stays archived"), "and never claims otherwise");
  const unknown = describeSentryDisposition("unknown", "9");
  assert(unknown.includes("UNKNOWN"), "an incomplete request is unknown");
  assert(unknown.includes("Read the issue"), "and tells the operator to look");
  assert(
    describeSentryDisposition("not-attempted", "9").includes("never touched"),
    "a pre-PUT failure touched nothing",
  );

  // isDefiniteRejection separates "Sentry evaluated this and declined" from
  // "we never learned whether it applied".
  for (const status of [400, 401, 403, 404, 409, 429]) {
    assertEqual(
      isDefiniteRejection(
        new Error(`Sentry archive request failed: ${status} Nope (9)`),
      ),
      true,
      `${status} is a refusal`,
    );
  }
  // A 5xx is NOT a refusal: Sentry may have applied the PUT before its server or
  // proxy failed, so the outcome is ambiguous and must disarm the approval.
  for (const status of [500, 502, 503, 504]) {
    assertEqual(
      isDefiniteRejection(
        new Error(`Sentry archive request failed: ${status} Bad Gateway (9)`),
      ),
      false,
      `${status} is ambiguous, not a refusal`,
    );
  }
  assertEqual(isDefiniteRejection(new Error("socket hang up")), false);
  assertEqual(isDefiniteRejection(new Error("fetch failed")), false);
});

await test("a 5xx on the archive PUT reports unknown and spends the approval", async () => {
  // The last place that inferred an outcome from an error rather than from live
  // state. A 502 left the approval spendable and told the operator nothing was
  // archived — while Sentry may well have applied the write.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({ archive: { ok: false, status: 502 } });
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await assertRejects(
      runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
      /502/,
    );
  } finally {
    process.stderr.write = write;
  }

  assertEqual(
    model.labels.includes("sentry:approved-archive"),
    false,
    "an ambiguous PUT must not leave a spendable approval",
  );
  const summary = stderr.find((l) => l.includes("Rolled the queue stub"));
  assert(summary, "the run still summarises what it did");
  assert(summary.includes("UNKNOWN"), "and calls the Sentry state unknown");
  assert(
    !summary.includes("was NOT archived"),
    "it must not claim the archive did not happen",
  );
});

await test("a rejected PUT reports 'not archived' end to end", async () => {
  const stub = makeStub();
  const { runGh } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({ archive: { ok: false, status: 403 } });
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await assertRejects(
      runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
      /403/,
    );
  } finally {
    process.stderr.write = write;
  }
  const summary = stderr.find((l) => l.includes("Rolled the queue stub"));
  assert(summary, "the run still summarises what it did");
  assert(summary.includes("was NOT archived"), "and does not claim an archive");
});

await test("a settlement read that throws after the PUT still spends the approval", async () => {
  // The exact gap: the freshness readback succeeded, then settlement's FIRST
  // readQueueIssue threw, so onTarget never ran. The outer catch reconciled with
  // a null target and — before the rule was hoisted — neither consumed the
  // approval nor recorded a baseline. Sentry archived, approval reusable, no
  // baseline: a workflow_dispatch retry enters the already-archived path and
  // stamps its own read time over whatever landed in between.
  const stub = makeStub();
  let views = 0;
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        views += 1;
        // View 1 is runArchive's pre-mutation read; view 2 is settlement's.
        if (views === 2) return "gh issue view failed: HTTP 500";
      }
      return null;
    },
  });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /view failed/,
  );

  assertEqual(
    fetchCalls.filter((c) => c.method === "PUT").length,
    1,
    "the archive stands — Sentry is not rolled back",
  );
  assertEqual(
    model.labels.includes("sentry:approved-archive"),
    false,
    "the approval is spent, so no retry can silently re-baseline",
  );
  // Nothing else was written: settlement never began.
  assertEqual(parseArchiveBaseline(model.body), null);
  assertEqual(model.state, "OPEN");
});

await test("the disarm rule covers every non-clean exit uniformly", () => {
  // The rule as a predicate, so a new archiveState cannot quietly fall outside.
  assertEqual(sentryMayBeArchived("confirmed"), true);
  assertEqual(sentryMayBeArchived("pre-existing"), true);
  assertEqual(sentryMayBeArchived("unknown"), true, "a lost response may hold");
  // Sentry answered and refused, so nothing is archived and the stub stays
  // re-dispatchable; likewise a run that never issued a PUT.
  assertEqual(sentryMayBeArchived("rejected"), false);
  assertEqual(sentryMayBeArchived("not-attempted"), false);
});

await test("a lost response on the disarm converges instead of demanding repair", async () => {
  // GitHub removes the label and the CLI loses the response. Taking that
  // rejection as proof the label survived reported the approval as still
  // spendable and demanded manual repair of a state that had already converged
  // — the last path exempt from the ambiguous-remote-write rule the queue
  // reconciler exists for.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    ambiguousOn: (args) =>
      args[1] === "edit" && args.includes("--remove-label")
        ? "gh issue edit: connection reset"
        : null,
  });
  const { fetchImpl } = makeFetch({
    lastSeenAfterPut: "2026-07-19T11:59:45.000Z",
  });
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = await runArchive(baseOptions(), {
      runGh,
      fetchImpl,
      now: FIXED_NOW,
    });
  } finally {
    process.stderr.write = write;
  }

  // The refusal stands as a policy outcome, not an operational failure.
  assertEqual(result.status, "reverted-fresh-events");
  assertEqual(
    model.labels.includes("sentry:approved-archive"),
    false,
    "the label really is gone",
  );
  assert(
    stderr.some((l) => l.includes("that the live labels disprove")),
    "the discrepancy is logged",
  );
  assert(
    !stderr.some((l) => l.includes("Remove the label by hand")),
    "and no manual repair is demanded for a converged state",
  );
});

await test("a disarm that genuinely fails still demands manual repair", async () => {
  // The complement: the label is still there on the re-read, so the hazard is
  // real and the existing ::error:: must survive.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "edit" && args.includes("--remove-label")
        ? "gh issue edit: HTTP 500"
        : null,
  });
  const { fetchImpl } = makeFetch({
    lastSeenAfterPut: "2026-07-19T11:59:45.000Z",
  });
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await assertRejects(
      runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
      /could not be shed|compensation was incomplete/,
    );
  } finally {
    process.stderr.write = write;
  }

  assert(
    model.labels.includes("sentry:approved-archive"),
    "the label really did survive",
  );
  assert(
    stderr.some((l) => l.includes("Remove the label by hand")),
    "a genuine failure still demands manual repair",
  );
});

await test("a definite rejection keeps the approval re-dispatchable", async () => {
  // The complement of the rule: Sentry refused the PUT, so nothing is archived,
  // nothing can be re-baselined, and burning the approval would make an operator
  // re-approve over a transient 403 for no safety gain.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({ archive: { ok: false, status: 403 } });

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /403/,
  );

  assert(
    model.labels.includes("sentry:approved-archive"),
    "a refused PUT leaves the approval alone",
  );
});

await test("settlementHeld verifies the baseline, not just state and labels", () => {
  const settled = {
    state: "CLOSED",
    labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:archived"],
    body: withArchiveBaseline(stubBody(), {
      lastSeen: BASELINE_LAST_SEEN,
      sentryIssueId: "6197137101",
    }),
  };
  const expected = {
    lastSeen: BASELINE_LAST_SEEN,
    sentryIssueId: "6197137101",
  };
  assertEqual(settlementHeld(settled, expected), true);
  // The baseline is what this whole change exists to guarantee, so a body write
  // that reported success but left it absent or wrong must NOT read as settled —
  // otherwise the run reports success on a closed sentry:archived stub whose
  // body sends ingest straight back to closedAt.
  assertEqual(
    settlementHeld({ ...settled, body: stubBody() }, expected),
    false,
    "absent baseline is not settled",
  );
  assertEqual(
    settlementHeld(
      {
        ...settled,
        body: withArchiveBaseline(stubBody(), {
          lastSeen: "2026-07-01T00:00:00.000Z",
          sentryIssueId: "6197137101",
        }),
      },
      expected,
    ),
    false,
    "a stale baseline is not settled",
  );
  assertEqual(
    settlementHeld(
      {
        ...settled,
        body: withArchiveBaseline(stubBody(), {
          lastSeen: BASELINE_LAST_SEEN,
          sentryIssueId: "999",
        }),
      },
      expected,
    ),
    false,
    "a baseline naming another issue is not settled",
  );
  // Shape failures still short-circuit, with or without an expectation.
  assertEqual(settlementHeld({ ...settled, state: "OPEN" }, expected), false);
  assertEqual(
    settlementHeld(settled),
    true,
    "no expectation checks shape only",
  );
});

await test("a body write that silently loses the baseline is not reported settled", async () => {
  // An authorised body edit races between the settlement write and the
  // verification read, wiping the baseline. State and labels still look right,
  // and state-and-labels alone would call this a successful archive.
  const stub = makeStub();
  let stripped = false;
  const { runGh, model } = makeRunGh({
    stub,
    beforeCall: (args) => {
      if (
        !stripped &&
        args[0] === "issue" &&
        args[1] === "view" &&
        parseArchiveBaseline(model.body)
      ) {
        model.body = stubBody();
        stripped = true;
      }
    },
  });
  const { fetchImpl } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(
    result.status,
    "unsettled-reopened",
    "a missing baseline must not read as a settled archive",
  );
  assertEqual(model.labels.includes("sentry:archived"), false);
  assertEqual(model.labels.includes("sentry:approved-archive"), false);
});

await test("reconciliation is idempotent — a second pass changes nothing", async () => {
  // The correctness bar for anything that reconciles: converged state is a fixed
  // point. Run the reconciler again against the state the first pass produced.
  const stub = makeStub();
  const { runGh, model } = makeRunGh({
    stub,
    ambiguousOn: (args) =>
      args[1] === "close" ? "gh issue close: connection reset" : null,
  });
  const { fetchImpl } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /connection reset/,
  );
  const settled = JSON.stringify(model);

  const report = await reconcileToTarget(
    { runGh, fetchImpl },
    {
      repo: "mento-protocol/monitoring-monorepo",
      queueIssue: 42,
      sentry: {
        baseUrl: "https://us.sentry.io",
        org: "mento-labs",
        token: TOKEN,
      },
      issueId: "6197137101",
      preArchive: { status: "unresolved", lastSeen: BASELINE_LAST_SEEN },
      target: {
        state: "OPEN",
        body: stub.body,
        hadArchivedLabel: false,
      },
    },
  );

  assertEqual(report.converged, true);
  assertEqual(report.queue, "already-consistent");
  assertEqual(JSON.stringify(model), settled, "no further writes");
});

await test("a queue rollback that cannot converge fails RED and says so", async () => {
  // The honest failure mode: reconciliation tried, live state still disagrees.
  // The operator needs one line that says what BOTH systems were observed to
  // hold, which is what the runbook entry points at.
  //
  // The reopen is ACCEPTED and does not take effect — the one shape only the
  // post-correction verification read catches, since the correction itself
  // reports success. A correction that throws is caught by the loop instead.
  const stub = makeStub();
  const { runGh } = makeRunGh({
    stub,
    ambiguousOn: (args) =>
      args[1] === "close" ? "gh issue close: connection reset" : null,
    noopOn: (args) => args[1] === "reopen",
  });
  const { fetchImpl } = makeFetch();
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await assertRejects(
      runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
      /connection reset/,
    );
  } finally {
    process.stderr.write = write;
  }
  const errorLine = stderr.find((l) => l.includes("::error::"));
  assert(errorLine, "a non-converged rollback must be loud");
  assert(errorLine.includes("did NOT converge"), "says it did not converge");
  assert(
    errorLine.includes("archived_until_escalating"),
    "states plainly that Sentry is left archived by design",
  );
  assert(errorLine.includes("Fix the stub"), "points at the recoverable side");
});

await test("a stub that arrived closed is not reopened by the repair", async () => {
  // Only undo what THIS run did. A stub already CLOSED on arrival (a retry, or
  // one the verdict path closed) must stay closed — reopening it would be a
  // fresh side effect the run never had the right to make.
  const stub = makeStub({ state: "CLOSED" });
  const { runGh, calls, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "edit" && args.includes("--add-label")
        ? "gh issue edit failed: HTTP 502"
        : null,
  });
  const { fetchImpl } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /HTTP 502/,
  );

  assert(!ghCall(calls, "close"), "nothing to close");
  assert(!ghCall(calls, "reopen"), "and therefore nothing to reopen");
  assertEqual(model.state, "CLOSED", "a stub that arrived closed stays closed");
});

await test("a settlement failure reverts nothing when this run did not archive", async () => {
  // The issue was already archived_until_escalating, so this run issued no PUT
  // and has nothing to undo — the compensation must not invent a mutation.
  const stub = makeStub({ body: settledStubBody() });
  const { runGh, model } = makeRunGh({
    stub,
    failOn: (args) =>
      args[1] === "edit" && args.includes("--add-label")
        ? "gh issue edit failed: HTTP 502"
        : null,
  });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: { status: "ignored", substatus: "archived_until_escalating" },
  });

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /HTTP 502/,
  );

  assert(
    !fetchCalls.some((c) => c.method === "PUT"),
    "no Sentry mutation to make and none to revert",
  );
  // The QUEUE side is still rolled back — that half does not depend on whether
  // this run was the one that archived Sentry.
  assertEqual(model.state, "OPEN", "the close this run made is still undone");
});

// ---------------------------------------------------------------------------
// Approval-marker compare-and-swap (issue #1371, race A).
// ---------------------------------------------------------------------------

await test("isNotFoundError recognizes a gh 404 and nothing else", () => {
  assertEqual(
    isNotFoundError(
      new Error("gh api failed with exit 1:\ngh: Not Found (HTTP 404)"),
    ),
    true,
  );
  assertEqual(
    isNotFoundError(new Error("HTTP 500 Internal Server Error")),
    false,
  );
  assertEqual(isNotFoundError(new Error("connection reset")), false);
  assertEqual(isNotFoundError("not an error"), false);
});

await test("losing the approval CAS aborts settlement, leaving Sentry archived", async () => {
  // The pre-settlement re-read still shows a fully-labeled stub, but ingest's
  // regression reopen sheds sentry:approved-archive in the sub-second window
  // before the close. The DELETE 404s, so this run lost: nothing is closed or
  // marked archived, and the Sentry archive it just made is undone.
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({
    stub,
    approvalLabelGone: true,
  });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "unsettled-reopened");
  assert(casCall(ghCalls), "the CAS was attempted");
  assert(!ghCall(ghCalls, "close"), "must not close after losing the CAS");
  assert(
    !labelEditCall(ghCalls, "--add-label"),
    "must not apply sentry:archived",
  );
  assert(!ghCall(ghCalls, "comment"), "must not post an audit comment");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 1, "Sentry keeps the approved archive");
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
});

await test("a non-404 CAS failure rolls back the queue, not just throws", async () => {
  // The DELETE can fail AFTER GitHub removed the label — a lost response is the
  // dangerous shape. The approval is then spent, this run cannot be
  // re-dispatched, and without compensation the Sentry issue stays archived with
  // no revert line in the log for the runbook to point an operator at.
  //
  // Asserting only that the promise rejects would pass with the compensation
  // absent, which is how this gap survived earlier review rounds: assert the
  // restore PUT actually fires.
  const stub = makeStub();
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "view") return JSON.stringify(stub);
    if (a0 === "label" && a1 === "create") return "";
    if (a0 === "api" && a1 === "-X") {
      throw new Error("gh api failed with exit 1:\ngh: HTTP 503");
    }
    if (
      a0 === "issue" &&
      (a1 === "edit" || a1 === "reopen" || a1 === "comment")
    )
      return "";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const { fetchImpl, calls: fetchCalls } = makeFetch();
  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /503/,
  );

  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 1, "Sentry keeps the approved archive");
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  // Nothing was written to the queue, so nothing needs undoing there.
  assert(!ghCall(calls, "close"), "no close happened");
  assert(!ghCall(calls, "reopen"), "so no reopen is needed");
});

// ---------------------------------------------------------------------------
// Post-mutation freshness re-check (issue #1371, race B).
// ---------------------------------------------------------------------------

await test("lastSeenMoved compares timestamps and ignores unparsable input", () => {
  assertEqual(
    lastSeenMoved("2026-07-19T11:59:00Z", "2026-07-19T11:59:30Z"),
    true,
  );
  // Fractional seconds must compare numerically, not lexically.
  assertEqual(
    lastSeenMoved("2026-07-19T11:59:00Z", "2026-07-19T11:59:00.500Z"),
    true,
  );
  assertEqual(
    lastSeenMoved("2026-07-19T11:59:00Z", "2026-07-19T11:59:00Z"),
    false,
  );
  assertEqual(
    lastSeenMoved("2026-07-19T11:59:30Z", "2026-07-19T11:59:00Z"),
    false,
  );
  assertEqual(lastSeenMoved(null, "2026-07-19T11:59:30Z"), false);
  assertEqual(lastSeenMoved("2026-07-19T11:59:00Z", undefined), false);
  assertEqual(lastSeenMoved("garbage", "also garbage"), false);
});

await test("refusal comments state what the compensation actually did", () => {
  // restoreArchivedIssue no-ops when another actor already moved the issue off
  // our archive. Claiming "the archive was reverted" there is a false statement
  // to whoever reads the stub, in a branch that leaves Sentry in a state nobody
  // on that run chose.
  for (const build of [
    buildFreshEventRefusalComment,
    buildUnreadableFreshnessRefusalComment,
  ]) {
    const reverted = build("GOV-1", true);
    assert(
      reverted.includes("The archive was reverted."),
      "a real revert says so",
    );
    assert(
      !reverted.includes("could NOT be reverted"),
      "a real revert must not warn",
    );

    const notReverted = build("GOV-1", false);
    assert(
      notReverted.includes("could NOT be reverted"),
      "a failed revert must say so",
    );
    assert(
      !notReverted.includes("The archive was reverted."),
      "a failed revert must not claim one",
    );
    assert(
      notReverted.includes("Check the Sentry issue."),
      "a failed revert points the human at Sentry",
    );
  }
});

await test("a refusal that could not revert says so on the stub", async () => {
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({
    lastSeenAfterPut: "2026-07-19T11:59:45.000Z",
    concurrentMoveAfterReadBack: true,
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "unreverted-fresh-events");
  const comment = ghCall(ghCalls, "comment");
  const body = comment[comment.indexOf("--body") + 1];
  assert(
    body.includes("could NOT be reverted"),
    "the stub comment must not claim a revert that did not happen",
  );
});

await test("an event landing inside the mutation window reverts and refuses", async () => {
  // Sentry's substatus lags a fresh event, so the live-regression guard passes
  // while an event is already in flight. The post-PUT lastSeen moved, so the
  // archive is undone and the stub is left open — closing it here would put the
  // close after the event and the reopen gate would never fire for it.
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    lastSeenAfterPut: "2026-07-19T11:59:45.000Z",
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "reverted-fresh-events");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 2);
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  assertDeepEqual(puts[1].body, { status: "unresolved" });
  assert(!ghCall(ghCalls, "close"), "must not close over the fresh event");
  assert(
    !casCall(ghCalls),
    "settlement never ran, so the approval is not consumed by the CAS",
  );
  assert(
    !fetchCalls.some((c) => c.method === "POST"),
    "no Sentry link-back for an archive that was reverted",
  );
  const comment = ghCall(ghCalls, "comment");
  assert(comment, "posts a refusal comment");
  assert(
    comment[comment.indexOf("--body") + 1].includes("Not archived."),
    "the refusal explains why",
  );
  // The dispatch guard only requires sentry:approved-archive, so leaving it
  // would let a bare retry archive over this same event with no fresh review.
  const edit = ghCall(ghCalls, "edit");
  assert(edit, "sheds the approval so a retry needs a fresh human approval");
  assertEqual(
    edit[edit.indexOf("--remove-label") + 1],
    "sentry:approved-archive",
  );
  assert(
    !edit.includes("--add-label"),
    "a freshness refusal is not a re-triage — the verdict labels stay",
  );
});

await test("a THROWN post-archive readback compensates instead of escaping", async () => {
  // `fetchSentryIssue` throws on any non-2xx or transport error. Letting that
  // propagate exits with the issue archived and the approval still live, so the
  // documented workflow_dispatch retry walks into the alreadyArchived branch and
  // records the RETRY-time lastSeen as its baseline — silently absorbing
  // whatever landed during the failed run's window. Same class as the CAS gap.
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    readbackThrows: "Sentry issue fetch failed: 502 Bad Gateway",
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "reverted-unreadable-freshness");
  // The archive is undone…
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 2);
  assertDeepEqual(puts[1].body, { status: "unresolved" });
  // …and the approval is invalidated BEFORE a retry can spend it.
  const removal = labelEditCall(ghCalls, "--remove-label");
  assert(removal, "the approval label is shed");
  assertEqual(
    removal[removal.indexOf("--remove-label") + 1],
    "sentry:approved-archive",
  );
  assert(!ghCall(ghCalls, "close"), "nothing is settled");
  assert(!casCall(ghCalls), "settlement never started");
});

await test("the approval is shed before the restore, so a failed restore still disarms the retry", async () => {
  // The restore is the larger, likelier-to-fail call. If it fails after the
  // approval was already shed, a dispatch retry cannot re-archive over the
  // event — and the run goes RED rather than reporting a clean refusal.
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({
    lastSeenAfterPut: "2026-07-19T11:59:45.000Z",
    restoreThrows: "Sentry restore (compensation) request failed: 500",
  });

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /compensation was incomplete/,
  );

  const removal = labelEditCall(ghCalls, "--remove-label");
  assert(removal, "the approval was shed even though the restore failed");
  assertEqual(
    removal[removal.indexOf("--remove-label") + 1],
    "sentry:approved-archive",
  );
  // Ordering is the point: shed first, restore second.
  assert(!ghCall(ghCalls, "close"), "nothing is settled");
});

await test("an unchanged lastSeen proceeds to a normal settlement", async () => {
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "archived");
  assertEqual(fetchCalls.filter((c) => c.method === "PUT").length, 1);
  assert(ghCall(ghCalls, "close"), "the stub settles normally");
});

await test("the baseline written into the stub body round-trips through the ingest parser", async () => {
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch();

  await runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW });

  const parsed = writtenBaseline(ghCalls);
  assert(parsed, "the stub body must carry a parseable baseline");
  assertEqual(parsed.lastSeen, BASELINE_LAST_SEEN);
  assertEqual(parsed.sentryIssueId, "6197137101");
  // The baseline is the pre-mutation lastSeen, which is what the ingest reopen
  // gate needs — not the close timestamp.
  assertEqual(
    Date.parse(parsed.lastSeen) < Date.parse(FIXED_NOW().toISOString()),
    true,
  );
  // The rewrite must PRESERVE the ingest metadata it extends — losing short_id
  // or the permalink would break every other reader of this stub.
  const edit = bodyEditCall(ghCalls);
  const newBody = edit[edit.indexOf("--body") + 1];
  for (const keep of [
    "short_id",
    "sentry_issue_id",
    "project",
    "permalink",
    "<!-- sentry-triage:v1 -->",
  ]) {
    assert(newBody.includes(keep), `body rewrite dropped ${keep}`);
  }
});

await test("the baseline goes in the body, never in a comment", async () => {
  // The trust boundary, asserted as a shape. The Stage B triage agent holds
  // `Bash(gh issue comment <its stub>:*)` and posts as github-actions[bot], so a
  // prompt-injected payload can forge any comment — author, marker and id fences
  // included. A machine-read baseline must therefore never live in one.
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch();

  await runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW });

  const comment = ghCall(ghCalls, "comment");
  const commentBody = comment[comment.indexOf("--body") + 1];
  assertEqual(
    parseArchiveBaseline(commentBody),
    null,
    "no machine-readable baseline may be parseable out of the audit comment",
  );
  assert(writtenBaseline(ghCalls), "it lives in the body instead");
});

await test("a forged baseline comment cannot influence the reopen decision", async () => {
  // End to end on the ingest side: the exact comment a prompt-injected triage
  // agent could post — trusted bot author, correct marker, correct Sentry id,
  // far-future lastSeen — must not be readable as a baseline, because ingest
  // only ever parses the stub BODY.
  const forged = buildAuditComment({
    approver: APPROVER,
    shortId: "GOVERNANCE-MENTO-ORG-51",
    sentryIssueId: "6197137101",
    permalink: null,
    timestampIso: "2026-07-18T12:00:00.000Z",
    baselineLastSeen: "2099-01-01T00:00:00.000Z",
  });
  assertEqual(
    parseArchiveBaseline(forged),
    null,
    "the audit comment carries no parseable baseline for anyone to forge",
  );
  // And a stub body with no baseline yields none, so the decision falls back to
  // closedAt rather than to attacker-supplied data.
  assertEqual(parseArchiveBaseline(stubBody()), null);
});

await test("isUsableBaseline accepts only a real date", () => {
  assertEqual(isUsableBaseline("2026-07-19T11:59:00.000Z"), true);
  for (const bad of [null, undefined, "", "   ", "not-a-date", "{}"]) {
    assertEqual(isUsableBaseline(bad), false);
  }
});

await test("an unusable pre-PUT lastSeen refuses before any mutation", async () => {
  // Fail CLOSED. Archiving here would record a junk baseline, ingest would
  // silently fall back to the closedAt comparison, and race B would be wide
  // open again with nothing downstream able to detect it.
  for (const badLastSeen of [undefined, "", "not-a-date"]) {
    const stub = makeStub();
    const { runGh, calls: ghCalls } = makeRunGh({ stub });
    const { fetchImpl, calls: fetchCalls } = makeFetch({
      issue: { status: "unresolved", lastSeen: badLastSeen },
    });

    const result = await runArchive(baseOptions(), {
      runGh,
      fetchImpl,
      now: FIXED_NOW,
    });

    assertEqual(result.status, "skipped-no-baseline");
    assert(
      !fetchCalls.some((c) => c.method === "PUT"),
      "no Sentry mutation without a usable baseline",
    );
    assert(!casCall(ghCalls), "the human approval must survive for a retry");
    assert(!ghCall(ghCalls, "close"), "the stub stays open");
    assert(!ghCall(ghCalls, "edit"), "no label changes at all");
    const comment = ghCall(ghCalls, "comment");
    assert(comment, "explains the refusal on the stub");
    assert(
      comment[comment.indexOf("--body") + 1].includes("no usable `lastSeen`"),
      "the refusal names the missing baseline",
    );
  }
});

await test("an unreadable post-PUT lastSeen reverts and refuses", async () => {
  // The field parsed before the PUT, so a malformed read-back is anomalous and
  // cannot establish that nothing moved. Treat it as a refusal, not a pass.
  const stub = makeStub();
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    lastSeenAfterPut: "not-a-date",
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "reverted-unreadable-freshness");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 2);
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  assertDeepEqual(puts[1].body, { status: "unresolved" });
  assert(!ghCall(ghCalls, "close"), "the stub stays open");
  assert(
    !casCall(ghCalls),
    "settlement never ran, so the approval is not consumed by the CAS",
  );
  const comment = ghCall(ghCalls, "comment");
  assert(comment, "explains the refusal on the stub");
  const body = comment[comment.indexOf("--body") + 1];
  assert(
    body.includes("stopped reporting a usable `lastSeen`"),
    "the refusal names the unreadable read-back",
  );
  assert(
    !body.includes("A new Sentry event"),
    "must not claim an event landed — that is not what we observed",
  );
  // Same authority boundary as the fresh-event path: an unproven window must
  // not stay retryable off the old approval.
  const edit = ghCall(ghCalls, "edit");
  assert(edit, "sheds the approval so a retry needs a fresh human approval");
  assertEqual(
    edit[edit.indexOf("--remove-label") + 1],
    "sentry:approved-archive",
  );
  assert(
    !edit.includes("--add-label"),
    "a freshness refusal is not a re-triage — the verdict labels stay",
  );
});

// ---------------------------------------------------------------------------
// Audit-comment idempotency fence. The marker alone is not proof the audit was
// written: this repo is public, so anyone can post a comment containing it, and
// a stub archived before the baseline contract existed carries a marker with no
// baseline at all. Either would suppress the post while the run still closed the
// stub and applied sentry:archived — leaving ingest nothing to read.
// ---------------------------------------------------------------------------

/** A genuine audit comment as the archive leg emits it. */
function auditComment({
  sentryIssueId = "6197137101",
  baselineLastSeen = BASELINE_LAST_SEEN,
  login = "github-actions",
} = {}) {
  return {
    body: buildAuditComment({
      approver: APPROVER,
      shortId: "GOVERNANCE-MENTO-ORG-51",
      sentryIssueId,
      permalink: null,
      timestampIso: "2026-07-18T12:00:00.000Z",
      alreadyArchived: false,
      baselineLastSeen,
    }),
    author: { login },
  };
}

await test("isSettledAuditComment fences on author, marker, id AND archive generation", () => {
  // This governs a HUMAN-READABLE note only — the baseline moved to the body —
  // so its worst failure is a duplicate or a missing note, not a wrong decision.
  const key = { sentryIssueId: "6197137101", baseline: BASELINE_LAST_SEEN };
  assertEqual(isSettledAuditComment(auditComment(), key), true);
  // REST author shape is accepted too (`gh api` renders it as `user`).
  assertEqual(
    isSettledAuditComment(
      {
        ...auditComment(),
        author: undefined,
        user: { login: "github-actions[bot]" },
      },
      key,
    ),
    true,
  );
  // A drive-by commenter can paste the whole audit body verbatim.
  assertEqual(
    isSettledAuditComment(auditComment({ login: "drive-by" }), key),
    false,
  );
  // Marker must LEAD the body, exactly as buildAuditComment emits it.
  assertEqual(
    isSettledAuditComment(
      {
        body: `chatter\n${auditComment().body}`,
        author: { login: "github-actions" },
      },
      key,
    ),
    false,
  );
  // Marker alone, naming no issue, is not this stub's audit record.
  assertEqual(
    isSettledAuditComment(
      {
        body: `${ARCHIVE_COMMENT_MARKER}\n\nprevious audit`,
        author: { login: "github-actions" },
      },
      key,
    ),
    false,
  );
  // Bound to the issue being archived, not just to any archive.
  assertEqual(
    isSettledAuditComment(auditComment({ sentryIssueId: "999" }), key),
    false,
  );
  // …and to THIS archive. A stub archived, regressed, reopened by ingest (which
  // keeps its comments), re-triaged, re-approved and archived again would
  // otherwise match the PREVIOUS archive's note and suppress the new one,
  // losing the new approver, timestamp and disposition.
  assertEqual(
    isSettledAuditComment(
      auditComment({ baselineLastSeen: "2026-07-01T00:00:00.000Z" }),
      key,
    ),
    false,
  );
});

await test("runArchive does not double-post the audit comment on retry", async () => {
  const stub = makeStub({
    state: "CLOSED",
    body: settledStubBody(),
    comments: [auditComment()],
  });
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({
    issue: { status: "ignored", substatus: "archived_until_escalating" },
  });

  await runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW });

  assert(!ghCall(ghCalls, "comment"), "must not re-post the audit comment");
  assert(!ghCall(ghCalls, "close"), "must not re-close an already-closed stub");
  assert(ghCall(ghCalls, "edit"), "label swap still runs idempotently");
});

await test("a forged marker comment cannot suppress the baseline write", async () => {
  // The forgery that mattered: a comment the triage LLM could post, clearing
  // author + marker + id. It may now cost at most a skipped duplicate NOTE — it
  // must never stop the body baseline from being written, because that is what
  // ingest reads.
  const stub = makeStub({ comments: [auditComment({ login: "drive-by" })] });
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "archived");
  const parsed = writtenBaseline(ghCalls);
  assert(parsed, "the body baseline is written regardless of any comment");
  assertEqual(parsed.lastSeen, BASELINE_LAST_SEEN);
  assert(ghCall(ghCalls, "close"), "the stub still settles");
});

await test("a genuine bot-authored marker comment still suppresses the duplicate note", async () => {
  const stub = makeStub({
    state: "CLOSED",
    body: settledStubBody(),
    comments: [auditComment()],
  });
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch({
    issue: { status: "ignored", substatus: "archived_until_escalating" },
  });

  await runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW });

  assert(!ghCall(ghCalls, "comment"), "no duplicate audit note");
  // …but the baseline is still (re)written, since that is the load-bearing part.
  assert(writtenBaseline(ghCalls), "the body baseline is refreshed anyway");
});

await test("an audit comment for a different Sentry issue does not suppress the note", async () => {
  const stub = makeStub({ comments: [auditComment({ sentryIssueId: "999" })] });
  const { runGh, calls: ghCalls } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch();

  await runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW });

  assert(
    ghCall(ghCalls, "comment"),
    "a foreign audit note is not this issue's record",
  );
  assertEqual(writtenBaseline(ghCalls).sentryIssueId, "6197137101");
});

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

await test("parseArgs requires a positive integer issue", () => {
  assertThrows(() => parseArgs([]), /--issue must be a positive integer/);
  assertThrows(
    () => parseArgs(["--issue", "0"]),
    /--issue must be a positive integer/,
  );
});

await test("parseArgs reads the approver from flag then env fallback", () => {
  const fromFlag = parseArgs(["--issue", "42", "--approver", "octo"], {});
  assertEqual(fromFlag.approver, "octo");
  const fromEnv = parseArgs(["--issue", "42"], { ARCHIVE_APPROVER: "envuser" });
  assertEqual(fromEnv.approver, "envuser");
});

await test("parseArgs rejects unknown options", () => {
  assertThrows(() => parseArgs(["--nope"]), /Unknown option: --nope/);
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
