#!/usr/bin/env node
import {
  ARCHIVE_COMMENT_MARKER,
  ARCHIVE_PAYLOAD,
  archiveIssue,
  buildAuditComment,
  buildRestorePayload,
  isActivelyRegressing,
  isAlreadyArchived,
  isNumericId,
  isSafeSentryPermalink,
  parseArgs,
  parseStubMetadata,
  resolveArchiveToken,
  resolveIssueIdFromShortId,
  restoreArchivedIssue,
  runArchive,
  sanitizeApprover,
  stubIsArchivable,
} from "./sentry-triage-archive.mjs";

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

function makeRunGh({ stub, settleStub = null }) {
  const calls = [];
  let views = 0;
  const runGh = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "view") {
      // The first view is runArchive's pre-mutation read; the second is
      // settleQueueStub's live re-read. settleStub models a stub whose labels
      // changed (a regression reopen) between the two.
      const snapshot = views === 0 ? stub : (settleStub ?? stub);
      views += 1;
      return JSON.stringify(snapshot);
    }
    if (a0 === "label" && a1 === "create") return "";
    if (
      a0 === "issue" &&
      (a1 === "comment" || a1 === "edit" || a1 === "close")
    ) {
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { runGh, calls };
}

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

function makeFetch({
  issue = { status: "unresolved" },
  archive = { ok: true },
  linkback = { ok: true },
  resolveShortId = { groupId: "6197137101" },
} = {}) {
  const calls = [];
  // Stateful: a successful PUT transitions the issue so a later GET (the
  // idempotency re-check / compensation re-fetch) observes the new state.
  let currentIssue = { ...issue };
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
      return jsonResponse(currentIssue);
    }
    if (method === "PUT" && /\/issues\/[^/]+\/$/.test(url)) {
      if (archive.ok && body) {
        currentIssue = { status: body.status, substatus: body.substatus };
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

  // gh: label self-heal + audit comment + label swap + close.
  assert(
    ghCalls.some((a) => a[0] === "label" && a[1] === "create"),
    "labels are self-healed",
  );
  const comment = ghCall(ghCalls, "comment");
  assert(comment, "audit comment posted");
  assert(
    comment[comment.indexOf("--body") + 1].includes(ARCHIVE_COMMENT_MARKER),
    "audit comment carries the marker",
  );
  const edit = ghCall(ghCalls, "edit");
  assertEqual(edit[edit.indexOf("--add-label") + 1], "sentry:archived");
  assertEqual(
    edit[edit.indexOf("--remove-label") + 1],
    "sentry:approved-archive",
  );
  const close = ghCall(ghCalls, "close");
  assertEqual(close[close.indexOf("--reason") + 1], "completed");

  // The Sentry token must never appear in a gh argument.
  assert(
    !ghCalls.some((args) => args.some((a) => String(a).includes(TOKEN))),
    "the Sentry token must never reach a gh call",
  );
});

await test("runArchive is idempotent when the issue is already archived", async () => {
  const stub = makeStub();
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

await test("runArchive throws when the stub has no short_id", async () => {
  const stub = makeStub({ body: stubBody({ shortId: "" }) });
  const { runGh } = makeRunGh({ stub });
  const { fetchImpl } = makeFetch();
  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /no parseable Sentry short_id/,
  );
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

await test("runArchive reverts the Sentry archive when a regression reopens the stub mid-flight", async () => {
  // Labels are valid at the pre-mutation read (so Sentry IS archived), but a
  // regression reopen sheds them before settlement. The reopened stub must NOT
  // be closed/relabeled off the stale approval, AND the archive we just made
  // must be UNDONE so the regression stays surfaced.
  const stub = makeStub();
  const reopened = makeStub({ state: "OPEN" });
  reopened.labels = [
    { name: "sentry-triage" },
    { name: "sentry:needs-triage" },
  ];
  const { runGh, calls: ghCalls } = makeRunGh({ stub, settleStub: reopened });
  const { fetchImpl, calls: fetchCalls } = makeFetch();

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "reverted-reopened");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 2);
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  // Restores the captured pre-archive state (was unresolved), not a forced enum.
  assertDeepEqual(puts[1].body, { status: "unresolved" });
  assert(!ghCall(ghCalls, "close"), "reopened stub must not be closed");
  assert(!ghCall(ghCalls, "edit"), "reopened stub must not be relabeled");
  assert(!ghCall(ghCalls, "comment"), "no audit comment on the reopened stub");
});

await test("runArchive restores the exact prior archive mode on mid-flight revert", async () => {
  // The issue was archived_forever before this run (a mode we re-archive to
  // until-escalating). A mid-flight reopen must restore archived_forever, not
  // force unresolved.
  const stub = makeStub();
  const reopened = makeStub({ state: "OPEN" });
  reopened.labels = [
    { name: "sentry-triage" },
    { name: "sentry:needs-triage" },
  ];
  const { runGh } = makeRunGh({ stub, settleStub: reopened });
  const { fetchImpl, calls: fetchCalls } = makeFetch({
    issue: { status: "ignored", substatus: "archived_forever" },
  });

  const result = await runArchive(baseOptions(), {
    runGh,
    fetchImpl,
    now: FIXED_NOW,
  });

  assertEqual(result.status, "reverted-reopened");
  const puts = fetchCalls.filter((c) => c.method === "PUT");
  assertEqual(puts.length, 2);
  assertDeepEqual(puts[0].body, ARCHIVE_PAYLOAD);
  assertDeepEqual(puts[1].body, {
    status: "ignored",
    substatus: "archived_forever",
  });
});

await test("runArchive does not revert when the issue was already archived before the run", async () => {
  // If the issue was ALREADY archived_until_escalating (we issued no PUT) and
  // the stub is reopened mid-flight, there is nothing we archived to undo.
  const stub = makeStub();
  const reopened = makeStub({ state: "OPEN" });
  reopened.labels = [
    { name: "sentry-triage" },
    { name: "sentry:needs-triage" },
  ];
  const { runGh } = makeRunGh({ stub, settleStub: reopened });
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

await test("runArchive keeps the approval label when the stub close fails", async () => {
  // A transient close failure must NOT have already removed
  // sentry:approved-archive — otherwise the workflow_dispatch retry guard would
  // refuse the stranded open stub. The close runs BEFORE the label swap, so a
  // failed close means the approval-consuming edit never ran.
  const stub = makeStub();
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "view") return JSON.stringify(stub);
    if (a0 === "label" && a1 === "create") return "";
    if (a0 === "issue" && a1 === "close") {
      throw new Error("gh issue close failed: HTTP 500");
    }
    if (a0 === "issue" && (a1 === "comment" || a1 === "edit")) return "";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const { fetchImpl } = makeFetch();

  await assertRejects(
    runArchive(baseOptions(), { runGh, fetchImpl, now: FIXED_NOW }),
    /close failed/,
  );

  const editCall = calls.find((a) => a[0] === "issue" && a[1] === "edit");
  assert(
    !editCall,
    "the approval-removing label swap must not run before a successful close",
  );
});

await test("runArchive does not double-post the audit comment on retry", async () => {
  const stub = makeStub({
    state: "CLOSED",
    comments: [
      {
        body: `${ARCHIVE_COMMENT_MARKER}\n\nprevious audit`,
        author: { login: "github-actions" },
      },
    ],
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
