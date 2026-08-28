#!/usr/bin/env node
/**
 * Tests for the Sentry credential broker (issue #1711).
 *
 * The standard here is a DEMONSTRATED failure, not a passing test: every guard
 * below is asserted on its rejection (status AND reason) and on the upstream
 * never being reached, so removing the guard turns the test red rather than
 * merely changing a status code.
 *
 * The end-to-end drive through the REAL `@sentry/mcp-server@0.37.0` — handle in,
 * token out, region links rewritten — is a local verification step, not a repo
 * test: pulling that package into CI to prove a proxy forwards a header is a
 * bad trade. The recipe for re-running it (and for re-deriving the path
 * allowlist on a version bump) is in `docs/notes/sentry-triage-pipeline.md`.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_PATHS,
  BIND_HOST,
  assertTokenAbsentFromExecEnv,
  classify,
  handleMatches,
  handleServerError,
  isAllowedPath,
  isBackPressureHeader,
  isEntryPoint,
  readTokenFromStdin,
  resolveConfig,
  resolveRuntime,
  rewriteRegionLinks,
  startBroker,
} from "./sentry-mcp-broker.mjs";
import {
  PROTOCOL_VERSION,
  REQUIRED_TOOLS,
  drainMessages,
  encodeAnnotation,
  isEntryPoint as probeIsEntryPoint,
  listServerTools,
  missingTools,
  probeSentryToolset,
  requestSupervisorStop,
  resolveProbeConfig,
  spawnServerSupervisor,
} from "./sentry-mcp-probe.mjs";

const HANDLE = "h".repeat(64);
const REAL_CRED = "sntrys_the_real_read_only_token_value";

/** A stub Sentry that records what it was asked and with which credential. */
async function startUpstream(respond) {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      authorization: req.headers.authorization,
    });
    respond(req, res, url);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}

const jsonUpstream =
  (payload, status = 200) =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

/**
 * Boots a broker in front of a stub upstream. `startBroker` takes the origin
 * directly, so the https-only check in `resolveConfig` (tested separately) does
 * not stand in the way of an http stub here.
 */
async function withBroker(respond, run, overrides = {}) {
  const upstream = await startUpstream(respond);
  const logs = [];
  const broker = await startBroker({
    token: REAL_CRED,
    handle: HANDLE,
    upstream: upstream.origin,
    port: 0,
    log: (line) => logs.push(line),
    ...overrides,
  });
  const base = `http://127.0.0.1:${broker.address().port}`;
  try {
    await run({ base, upstream, broker, logs });
  } finally {
    broker.close();
    upstream.server.close();
  }
}

const call = (base, path, init = {}) =>
  fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${HANDLE}` },
    ...init,
  });

/** Sends a literal request line, bypassing fetch's URL normalisation. */
function rawRequest(base, requestLine) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `${requestLine}\r\nHost: ${hostname}:${port}\r\nAuthorization: Bearer ${HANDLE}\r\nConnection: close\r\n\r\n`,
      );
    });
    let out = "";
    socket.on("data", (chunk) => (out += chunk.toString()));
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}

// ── binding ──────────────────────────────────────────────────────────────────

test("the broker binds loopback ONLY — a leaked handle is useless off-runner", async () => {
  assert.equal(BIND_HOST, "127.0.0.1");
  await withBroker(jsonUpstream([]), async ({ broker }) => {
    // Not a restatement of the constant: this is the address the kernel bound.
    assert.equal(broker.address().address, "127.0.0.1");
  });
});

// ── the happy path: handle in, real token out ───────────────────────────────

test("an allowed GET reaches Sentry with the REAL token, never the handle", async () => {
  await withBroker(
    jsonUpstream({ id: "777", shortId: "MONITORING-1" }),
    async ({ base, upstream }) => {
      const res = await call(
        base,
        "/api/0/organizations/mento-org/issues/MONITORING-1/",
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        id: "777",
        shortId: "MONITORING-1",
      });
      assert.equal(upstream.seen.length, 1);
      assert.equal(
        upstream.seen[0].pathname,
        "/api/0/organizations/mento-org/issues/MONITORING-1/",
      );
      assert.equal(upstream.seen[0].authorization, `Bearer ${REAL_CRED}`);
      assert.ok(
        !upstream.seen[0].authorization.includes(HANDLE),
        "the run handle must never reach Sentry",
      );
    },
  );
});

test("the query string is forwarded verbatim", async () => {
  await withBroker(
    jsonUpstream({ data: [], meta: {} }),
    async ({ base, upstream }) => {
      await call(
        base,
        "/api/0/organizations/mento-org/events/?dataset=errors&query=is%3Aunresolved&per_page=10",
      );
      assert.equal(
        upstream.seen[0].search,
        "?dataset=errors&query=is%3Aunresolved&per_page=10",
      );
    },
  );
});

// ── fail closed: handle ──────────────────────────────────────────────────────

test("a WRONG handle is refused and never reaches Sentry", async () => {
  await withBroker(jsonUpstream([]), async ({ base, upstream, logs }) => {
    const res = await fetch(`${base}/api/0/organizations/`, {
      headers: { authorization: `Bearer ${"x".repeat(64)}` },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      detail: "sentry-mcp-broker: invalid run handle",
    });
    assert.equal(upstream.seen.length, 0, "upstream must not be contacted");
    assert.ok(logs.some((line) => line.includes("DENY 401")));
  });
});

test("a MISSING handle is refused and never reaches Sentry", async () => {
  await withBroker(jsonUpstream([]), async ({ base, upstream }) => {
    const res = await fetch(`${base}/api/0/organizations/`);
    assert.equal(res.status, 401);
    assert.match((await res.json()).detail, /invalid run handle/);
    assert.equal(upstream.seen.length, 0);
  });
});

test("a handle that is a PREFIX of the real one is refused", async () => {
  await withBroker(jsonUpstream([]), async ({ base, upstream }) => {
    const res = await fetch(`${base}/api/0/organizations/`, {
      headers: { authorization: `Bearer ${HANDLE.slice(0, -1)}` },
    });
    assert.equal(res.status, 401);
    assert.equal(upstream.seen.length, 0);
  });
});

test("handleMatches rejects empty, short, long and near-miss values", () => {
  assert.equal(handleMatches(HANDLE, HANDLE), true);
  assert.equal(handleMatches("", HANDLE), false);
  assert.equal(handleMatches(undefined, HANDLE), false);
  assert.equal(handleMatches(HANDLE.slice(0, -1), HANDLE), false);
  assert.equal(handleMatches(`${HANDLE}x`, HANDLE), false);
  assert.equal(handleMatches(`${HANDLE.slice(0, -1)}X`, HANDLE), false);
  // An empty expected handle must not accept an empty presented one.
  assert.equal(handleMatches("", ""), false);
});

// ── fail closed: method ──────────────────────────────────────────────────────

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} is refused outright — nothing granted mutates`, async () => {
    await withBroker(jsonUpstream({}), async ({ base, upstream }) => {
      const res = await call(
        base,
        "/api/0/organizations/mento-org/issues/MONITORING-1/",
        { method, body: method === "DELETE" ? undefined : "{}" },
      );
      assert.equal(res.status, 405);
      assert.equal(
        (await res.json()).detail,
        `sentry-mcp-broker: method ${method} is not proxied (read-only broker)`,
      );
      assert.equal(upstream.seen.length, 0);
    });
  });
}

// ── fail closed: path ────────────────────────────────────────────────────────

test("a path OUTSIDE the allowlist is refused and never reaches Sentry", async () => {
  await withBroker(jsonUpstream({}), async ({ base, upstream }) => {
    const res = await call(base, "/api/0/users/me/");
    assert.equal(res.status, 403);
    assert.equal(
      (await res.json()).detail,
      "sentry-mcp-broker: path not allowed: /api/0/users/me/",
    );
    assert.equal(upstream.seen.length, 0);
  });
});

test("dot-segment and percent-encoded traversal are refused", async () => {
  await withBroker(jsonUpstream({}), async ({ base, upstream }) => {
    // A raw socket, because fetch normalises `..` client-side and would test
    // its own URL parser rather than the broker's. This is the shape an
    // attacker controls.
    const raw = await rawRequest(
      base,
      "GET /api/0/organizations/mento-org/../../../users/me/ HTTP/1.1",
    );
    assert.match(raw, /^HTTP\/1\.1 403 /);
    // Resolved before the allowlist saw it, and refused on the resolved value.
    assert.match(raw, /path not allowed: \/api\/users\/me\//);
    assert.ok(!raw.includes(".."), "the raw path must not survive resolution");
    // `%` is outside the segment charset, so an encoded traversal cannot match.
    const encoded = await call(base, "/api/0/organizations/%2e%2e/projects/");
    assert.equal(encoded.status, 403);
    assert.equal(upstream.seen.length, 0);
  });
});

test("the allowlist admits every derived path and nothing adjacent", () => {
  for (const allowed of [
    "/api/0/organizations/",
    "/api/0/organizations/mento-org/",
    "/api/0/organizations/mento-org/projects/",
    "/api/0/organizations/mento-org/issues/",
    "/api/0/organizations/mento-org/issues/MONITORING-1/",
    "/api/0/organizations/mento-org/issues/777/events/latest/",
    "/api/0/organizations/mento-org/issues/777/events/abc123/",
    "/api/0/organizations/mento-org/issues/777/autofix/",
    "/api/0/organizations/mento-org/issues/777/external-issues/",
    "/api/0/organizations/mento-org/replay-count/",
    "/api/0/organizations/mento-org/events/",
    "/api/0/organizations/mento-org/events/validate/",
    "/api/0/organizations/mento-org/replays/",
    "/api/0/organizations/mento-org/replays/abc123/",
    "/api/0/organizations/mento-org/trace/abc123/",
    "/api/0/organizations/mento-org/trace-meta/abc123/",
    "/api/0/organizations/mento-org/ai-conversations/conv-1/",
    "/api/0/organizations/mento-org/monitors/my-monitor/",
    "/api/0/organizations/mento-org/preprodartifacts/snapshots/snap-1/",
    "/api/0/organizations/mento-org/preprodartifacts/snapshots/snap-1/images/img.png/",
    "/api/0/projects/mento-org/monitoring/",
  ]) {
    assert.equal(isAllowedPath(allowed), true, `should allow ${allowed}`);
  }
  for (const denied of [
    // Write and account surfaces the granted tools never touch.
    "/api/0/users/me/",
    "/api/0/organizations/mento-org/members/",
    "/api/0/organizations/mento-org/issues/777/tags/environment/values/",
    "/api/0/organizations/mento-org/issues/777/activities/",
    // Prefix and suffix near-misses.
    "/api/0/organizations/mento-org/issues/777/events/latest/attachments/",
    "/api/0/organizations",
    "/api/0/organizations/mento-org/projects",
    "/organizations/",
    "/",
    // A slug carrying a path separator or an escape must not slip through.
    "/api/0/organizations/mento%2Forg/projects/",
    "/api/0/projects/mento-org/monitoring/keys/",
  ]) {
    assert.equal(isAllowedPath(denied), false, `should deny ${denied}`);
  }
  assert.ok(ALLOWED_PATHS.length > 0);
});

test("classify puts the handle check first and returns null only when all three pass", () => {
  const allowed = "/api/0/organizations/";
  assert.equal(
    classify(
      { method: "GET", authorization: `Bearer ${HANDLE}`, pathname: allowed },
      HANDLE,
    ),
    null,
  );
  // A bad handle is refused even when method and path are fine.
  assert.equal(
    classify(
      { method: "GET", authorization: "Bearer nope", pathname: allowed },
      HANDLE,
    ).status,
    401,
  );
  // A bad handle on a disallowed path still reports 401, not 403: an
  // unauthenticated caller learns nothing about the path policy.
  assert.equal(
    classify(
      {
        method: "GET",
        authorization: "Bearer nope",
        pathname: "/api/0/users/me/",
      },
      HANDLE,
    ).status,
    401,
  );
});

// ── the region-url rewrite ───────────────────────────────────────────────────

test("organization payloads are re-pointed at the broker, so region reads stay local", async () => {
  const upstreamOrg = {
    slug: "mento-org",
    links: {
      regionUrl: "https://us.sentry.io",
      organizationUrl: "https://mento-org.sentry.io",
    },
  };
  await withBroker(jsonUpstream([upstreamOrg]), async ({ base, broker }) => {
    const res = await call(base, "/api/0/organizations/");
    const [org] = await res.json();
    assert.equal(
      org.links.regionUrl,
      `https://127.0.0.1:${broker.address().port}`,
    );
    // The human-facing permalink base is NOT rewritten: verdict comments must
    // carry real Sentry links.
    assert.equal(org.links.organizationUrl, "https://mento-org.sentry.io");
  });
});

test("the single-organization payload is rewritten too", async () => {
  await withBroker(
    jsonUpstream({
      slug: "mento-org",
      links: { regionUrl: "https://us.sentry.io" },
    }),
    async ({ base, broker }) => {
      const res = await call(base, "/api/0/organizations/mento-org/");
      assert.equal(
        (await res.json()).links.regionUrl,
        `https://127.0.0.1:${broker.address().port}`,
      );
    },
  );
});

test("non-organization payloads are relayed byte-for-byte", async () => {
  const issue = {
    id: "777",
    links: { regionUrl: "https://us.sentry.io" },
    permalink: "https://mento-org.sentry.io/issues/777/",
  };
  await withBroker(jsonUpstream(issue), async ({ base }) => {
    const res = await call(base, "/api/0/organizations/mento-org/issues/777/");
    assert.deepEqual(await res.json(), issue);
  });
});

test("rewriteRegionLinks touches only links.regionUrl", () => {
  const payload = [
    {
      slug: "a",
      links: {
        regionUrl: "https://us.sentry.io",
        organizationUrl: "https://a",
      },
    },
    { slug: "b" },
    { slug: "c", links: {} },
  ];
  rewriteRegionLinks(payload, "https://127.0.0.1:9401");
  assert.equal(payload[0].links.regionUrl, "https://127.0.0.1:9401");
  assert.equal(payload[0].links.organizationUrl, "https://a");
  assert.equal(payload[1].links, undefined);
  assert.equal("regionUrl" in payload[2].links, false);
});

test("a socket error AFTER startup is logged AND fails the broker closed", async () => {
  // Two halves, and the second is the one that reaches the workflow. The
  // startup promise's `reject` used to be the server's only `error` listener,
  // and once that promise settles it is a no-op, so every later socket error
  // vanished. Logging alone does not fix that: the workflow sends both broker
  // streams to a file it prints only when readiness fails, so a line written
  // after readiness is read by nobody and the agent keeps spending its turn
  // budget against a broker that has stopped accepting.
  const exits = [];
  await withBroker(
    jsonUpstream([]),
    async ({ broker, logs }) => {
      broker.emit("error", new Error("EADDRNOTAVAIL after startup"));
      assert.ok(
        logs.some((line) => line.includes("SERVER-ERROR")),
        `a post-startup server error must reach the log; saw ${JSON.stringify(logs)}`,
      );
      assert.ok(
        logs.some((line) => line.includes("EADDRNOTAVAIL after startup")),
        "the log line must name what actually failed",
      );
      assert.deepEqual(exits, [1], "the broker must exit non-zero, not linger");
      assert.equal(
        broker.listening,
        false,
        "a broker that stopped accepting must not keep the port claimed",
      );
    },
    { exit: (code) => exits.push(code) },
  );
});

test("handleServerError says what failed before it stops, and stops regardless", () => {
  const lines = [];
  const exits = [];
  let closed = 0;
  const error = new Error("listening socket is gone");
  error.code = "EADDRNOTAVAIL";
  handleServerError(error, {
    server: {
      listening: false,
      close: () => {
        closed += 1;
        // The order is load-bearing: a close that throws must not swallow the
        // exit, or the fatal path leaves the broker alive after all.
        throw new Error("already down");
      },
    },
    log: (line) => lines.push(line),
    exit: (code) => exits.push(code),
  });
  assert.deepEqual(lines, [
    "sentry-mcp-broker: SERVER-ERROR listening socket is gone",
  ]);
  assert.equal(closed, 1);
  assert.deepEqual(exits, [1]);
});

test("a transient accept error does NOT take the broker down while it is still listening", () => {
  // One momentary fd squeeze is not a lost listener. Tearing down on it would
  // reach the same dead-broker outcome the fatal path exists to prevent, just
  // sooner — so a code known to be per-connection survives, and says so.
  for (const code of ["EMFILE", "ENFILE", "ENOBUFS", "ECONNABORTED"]) {
    const lines = [];
    const exits = [];
    let closed = 0;
    const error = new Error(`accept failed: ${code}`);
    error.code = code;
    handleServerError(error, {
      server: {
        listening: true,
        close: () => {
          closed += 1;
        },
      },
      log: (line) => lines.push(line),
      exit: (c) => exits.push(c),
    });
    assert.equal(closed, 0, `${code} must not close a live listener`);
    assert.deepEqual(exits, [], `${code} must not exit`);
    assert.ok(
      lines.some((line) => line.includes(`accept failed: ${code}`)),
      `${code} must still be reported`,
    );
    assert.ok(
      lines.some((line) => line.includes("staying up")),
      `${code} must say it stayed up`,
    );
  }
});

test("the fatal default holds: an unknown code, or a lost listener, stops the broker", () => {
  // The two directions are not symmetric. Staying up with the listener gone
  // restores the silence this whole handler exists to end; going down when it
  // was fine costs a run that fails visibly. So anything not KNOWN to be
  // per-connection is treated as the listener being gone.
  const cases = [
    ["an unknown code", "ESOMETHINGNEW", true],
    ["no code at all", undefined, true],
    ["a transient code but a listener that is gone", "EMFILE", false],
  ];
  for (const [label, code, listening] of cases) {
    const exits = [];
    let closed = 0;
    const error = new Error(label);
    if (code) error.code = code;
    handleServerError(error, {
      server: {
        listening,
        close: () => {
          closed += 1;
        },
      },
      log: () => {},
      exit: (c) => exits.push(c),
    });
    assert.equal(closed, 1, `${label} must close`);
    assert.deepEqual(exits, [1], `${label} must exit non-zero`);
  }
});

/** Runs `body` with `console.log` captured, restoring it however body ends. */
async function withCapturedConsole(body) {
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await body(lines);
  } finally {
    console.log = realLog;
  }
  return lines;
}

test("both broker diagnostics survive a caller that supplies no log sink", async () => {
  // An optional call on `config.log` puts the silence straight back for any
  // caller passing none, which is the defect both lines exist to end. The
  // console fallback is the one `createHandler` already applies.
  const upstream = await startUpstream(jsonUpstream([]));
  const exits = [];
  const broker = await startBroker({
    token: REAL_CRED,
    handle: HANDLE,
    upstream: upstream.origin,
    port: 0,
    exit: (code) => exits.push(code),
  });
  // An unparsable upstream makes the handler throw INSIDE the request path,
  // which is the only way to reach HANDLER-ERROR.
  const broken = await startBroker({
    token: REAL_CRED,
    handle: HANDLE,
    upstream: "not-a-url",
    port: 0,
    exit: (code) => exits.push(code),
  });
  let status = null;
  const lines = await withCapturedConsole(async () => {
    status = (
      await call(
        `http://127.0.0.1:${broken.address().port}`,
        "/api/0/organizations/",
      )
    ).status;
    broker.emit("error", new Error("no sink was supplied"));
  });
  broker.close();
  broken.close();
  upstream.server.close();

  assert.equal(status, 500, "a thrown handler still denies rather than hangs");
  assert.ok(
    lines.some((line) => line.includes("HANDLER-ERROR")),
    `the handler failure must reach the fallback; saw ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some(
      (line) =>
        line.includes("SERVER-ERROR") && line.includes("no sink was supplied"),
    ),
    `the socket failure must reach the fallback; saw ${JSON.stringify(lines)}`,
  );
});

// ── back-pressure ────────────────────────────────────────────────────────────

test("a throttled upstream reaches the client WITH its back-off headers", async () => {
  // The MCP server obeys `Retry-After` and the `X-Sentry-Rate-Limit-*` family.
  // Relaying only content-type and link turned a 429 into a bare status, so the
  // client retried at once against a Sentry that was still refusing it.
  await withBroker(
    (_req, res) => {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "42",
        "x-sentry-rate-limit-limit": "100",
        "x-sentry-rate-limit-remaining": "0",
        "x-sentry-rate-limit-reset": "1755600000",
        "x-sentry-rate-limit-concurrentlimit": "10",
        // Not back-pressure and not the broker's to relay.
        "set-cookie": "session=leak-me",
        "x-served-by": "sentry-edge-7",
      });
      res.end(JSON.stringify({ detail: "rate limited" }));
    },
    async ({ base }) => {
      const res = await call(base, "/api/0/organizations/");
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), "42");
      assert.equal(res.headers.get("x-sentry-rate-limit-limit"), "100");
      assert.equal(res.headers.get("x-sentry-rate-limit-remaining"), "0");
      assert.equal(res.headers.get("x-sentry-rate-limit-reset"), "1755600000");
      assert.equal(
        res.headers.get("x-sentry-rate-limit-concurrentlimit"),
        "10",
        "a name-by-name list would have dropped this one",
      );
      // Still an allowlist: everything else the upstream sent stays upstream.
      assert.equal(res.headers.get("set-cookie"), null);
      assert.equal(res.headers.get("x-served-by"), null);
    },
  );
});

test("isBackPressureHeader admits the two families and nothing else", () => {
  assert.equal(isBackPressureHeader("Retry-After"), true);
  assert.equal(isBackPressureHeader("X-Sentry-Rate-Limit-Reset"), true);
  assert.equal(isBackPressureHeader("x-sentry-rate-limit-anything-new"), true);
  assert.equal(isBackPressureHeader("authorization"), false);
  assert.equal(isBackPressureHeader("set-cookie"), false);
  assert.equal(isBackPressureHeader("x-sentry-token"), false);
  assert.equal(isBackPressureHeader(undefined), false);
  // The prefix carries its trailing hyphen, so a name that merely STARTS with
  // those letters is not the family and does not cross.
  assert.equal(isBackPressureHeader("x-sentry-rate-limitation"), false);
  assert.equal(isBackPressureHeader("x-sentry-rate-limiter-secret"), false);
  // Sentry's plural ingest header is not a Web API response header, and the
  // hyphen excludes it too; every ALLOWED_PATHS entry is a Web API read.
  assert.equal(isBackPressureHeader("x-sentry-rate-limits"), false);
});

// ── fail closed: redirects and upstream failures ─────────────────────────────

// NOTE ON THIS TEST'S FIDELITY: no test in this file passes `fetchImpl`, so the
// broker runs on the real global `fetch` throughout — here against a real local
// server returning a real 302. That matters: `redirect: "manual"` returning an
// opaque `status: 0` would make the refusal inert, and a stubbed `fetchImpl`
// would prove nothing about it. On this Node the response is `type: "basic"`
// with `status: 302`, so the `>= 300 && < 400` check does fire, and this test
// pins that rather than leaving it to inspection.
test("an upstream redirect is refused, never relayed (real fetch, real 302)", async () => {
  await withBroker(
    (_req, res) => {
      res.writeHead(302, {
        location: "https://us.sentry.io/api/0/organizations/",
      });
      res.end();
    },
    async ({ base, upstream }) => {
      // Pin the premise: real fetch, manual redirect, a non-opaque 3xx.
      const direct = await fetch(`${upstream.origin}/api/0/organizations/`, {
        redirect: "manual",
      });
      assert.equal(direct.status, 302, "the premise of the guard: a real 3xx");
      assert.equal(direct.type, "basic", "not an opaque response");

      const res = await call(base, "/api/0/organizations/");
      assert.equal(res.status, 502);
      assert.equal(
        (await res.json()).detail,
        "sentry-mcp-broker: upstream redirect not relayed",
      );
      assert.equal(
        res.headers.get("location"),
        null,
        "a Location header would let the MCP client follow it with the handle",
      );
    },
  );
});

test("an unreachable upstream fails closed with 502", async () => {
  const upstream = await startUpstream(jsonUpstream({}));
  const dead = upstream.origin;
  await new Promise((resolve) => upstream.server.close(resolve));
  const broker = await startBroker({
    token: REAL_CRED,
    handle: HANDLE,
    upstream: dead,
    port: 0,
    log: () => {},
  });
  try {
    const res = await call(
      `http://127.0.0.1:${broker.address().port}`,
      "/api/0/organizations/",
    );
    assert.equal(res.status, 502);
    assert.equal(
      (await res.json()).detail,
      "sentry-mcp-broker: upstream request failed",
    );
  } finally {
    broker.close();
  }
});

test("an upstream error status is relayed, not masked", async () => {
  await withBroker(
    jsonUpstream({ detail: "forbidden" }, 403),
    async ({ base }) => {
      const res = await call(base, "/api/0/organizations/");
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { detail: "forbidden" });
    },
  );
});

// ── configuration ────────────────────────────────────────────────────────────

test("resolveConfig fails loudly on a weak wiring, and takes NO token", () => {
  const base = {
    SENTRY_MCP_BROKER_HANDLE: HANDLE,
    SENTRY_MCP_BROKER_PORT: "9401",
  };
  assert.equal(resolveConfig(base).upstream, "https://us.sentry.io");
  assert.equal(resolveConfig(base).port, 9401);
  assert.equal(resolveConfig(base).ttlSeconds, 1800);
  // The token has NO env channel at all — it can only arrive on stdin. An env
  // channel is exactly what puts it in /proc/<pid>/environ.
  assert.ok(
    !("token" in resolveConfig(base)),
    "resolveConfig must not surface a token read from the environment",
  );

  assert.throws(
    () => resolveConfig({ ...base, SENTRY_MCP_BROKER_HANDLE: "" }),
    /SENTRY_MCP_BROKER_HANDLE is required/,
  );
  assert.throws(
    () => resolveConfig({ ...base, SENTRY_MCP_BROKER_HANDLE: "short" }),
    /at least 32 characters/,
  );
  assert.throws(
    () =>
      resolveConfig({
        ...base,
        SENTRY_MCP_BROKER_UPSTREAM: "http://us.sentry.io",
      }),
    /must be https/,
  );
  assert.throws(
    () => resolveConfig({ ...base, SENTRY_MCP_BROKER_PORT: "0" }),
    /must be a valid port/,
  );
  assert.throws(
    () => resolveConfig({ ...base, SENTRY_MCP_BROKER_TTL_SECONDS: "0" }),
    /must be a positive integer/,
  );
  // Required, not defaulted: a default is a second source of truth for a value
  // the workflow already pins once, and they would disagree only on a live run.
  const withoutPort = { ...base };
  delete withoutPort.SENTRY_MCP_BROKER_PORT;
  assert.throws(
    () => resolveConfig(withoutPort),
    /SENTRY_MCP_BROKER_PORT is required/,
  );
});

// ── the token's delivery channel ─────────────────────────────────────────────

test("readTokenFromStdin reassembles a chunked pipe and trims the writer's newline", async () => {
  const { Readable } = await import("node:stream");
  assert.equal(
    await readTokenFromStdin(Readable.from([`${REAL_CRED}\n`])),
    REAL_CRED,
  );
  assert.equal(
    await readTokenFromStdin(
      Readable.from([REAL_CRED.slice(0, 5), REAL_CRED.slice(5)]),
    ),
    REAL_CRED,
  );
});

test("readTokenFromStdin fails closed on a TTY and on silence", async () => {
  const { Readable } = await import("node:stream");
  const tty = Readable.from([]);
  tty.isTTY = true;
  await assert.rejects(() => readTokenFromStdin(tty), /must be piped on stdin/);

  const silent = new Readable({ read() {} }); // never ends
  await assert.rejects(
    () => readTokenFromStdin(silent, 40),
    /no token arrived on stdin within 40ms/,
  );
});

test("assertTokenAbsentFromExecEnv names the leaking variable, never the value", () => {
  assert.equal(
    assertTokenAbsentFromExecEnv(REAL_CRED, { PATH: "/usr/bin", CI: "true" }),
    undefined,
  );
  for (const leaking of [
    { SENTRY_TRIAGE_TOKEN: REAL_CRED },
    { SENTRY_MCP_BROKER_TOKEN: REAL_CRED },
    { SOME_URL: `https://x/?t=${REAL_CRED}&y=1` }, // embedded counts too
  ]) {
    const name = Object.keys(leaking)[0];
    assert.throws(
      () => assertTokenAbsentFromExecEnv(REAL_CRED, leaking),
      (error) => {
        assert.match(error.message, new RegExp(`as ${name};`));
        assert.match(error.message, /\/proc\/<pid>\/environ/);
        assert.match(error.message, /Do not scrub it at runtime/);
        assert.ok(
          !error.message.includes(REAL_CRED),
          "the refusal must name the variable, never the value",
        );
        return true;
      },
    );
  }
});

// ── the exec-time environment, observed from OUTSIDE the process ────────────
//
// The defect this closes: taking the token out of the AGENT's env did not take
// it out of the agent's REACH. Every step runs as `runner`, the agent holds
// `Read`, and `/proc/<pid>/environ` is same-UID readable — so the broker
// inheriting the token from its step's `env:` left it one `Read` away.
//
// READ THIS BEFORE TOUCHING THE PLATFORM SPLIT BELOW. An earlier revision used
// `ps -E -p <pid>` on every platform. That is BSD/macOS syntax: procps rejects
// `-E` as an "unsupported SysV option" — its `parse_sysv_option` has no
// `case 'E'` and falls to that default, while only the bare BSD `e` sets the
// environment flag. So on the Ubuntu runner the call errored, the reader
// returned null, and the tests that establish this entire credential boundary
// could not pass on the one platform we ship to. The defect was A VERIFICATION
// THAT COULD NOT RUN, not a product bug: the strongest-looking evidence in the
// change was inert exactly where it mattered. Keep this split, and keep it
// explicit.
//
// On Linux we read `/proc/<pid>/environ` directly. That is not an analogue of
// the threat — it IS the file a prompt-injected agent would open with `Read`.
// `ps -E` stays as the macOS fallback so the suite still means something
// locally. NEITHER READER MAY FAIL SOFT: a silent empty read would make every
// negative result below meaningless, which is the same class of mistake as the
// one above, so a failed read throws and turns the suite red rather than
// skipping. The positive control proves whichever reader is in play actually
// detects a leak, and that it still reports a variable the child DELETED at
// runtime — which is why a runtime scrub is theatre.

const BROKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "sentry-mcp-broker.mjs",
);

const ON_LINUX = platform() === "linux";

/** How the exec-time environment is being read, named in failure messages. */
const READER = ON_LINUX ? "/proc/<pid>/environ" : "ps -E -p <pid>";

/**
 * Decodes a `/proc/<pid>/environ` block: NUL-separated `KEY=VALUE` entries with
 * a trailing NUL. Split out so the Linux branch's decoding is covered by a test
 * even when the suite runs on a host without `/proc` — the file read itself
 * cannot be, and that gap is stated in the PR rather than papered over.
 */
function decodeProcBlock(buffer) {
  return buffer.toString("utf8").split("\0").join("\n");
}

/**
 * The exec-time environment of a live process, as an outsider sees it.
 * Throws on any failure — it must never return a falsy "nothing found".
 */
function execEnvironOf(pid) {
  if (ON_LINUX) {
    // A dead pid or an EACCES throws out of readFileSync, which is the point:
    // a failed read must never read as "no token here".
    return decodeProcBlock(readFileSync(`/proc/${pid}/environ`));
  }
  return execFileSync("ps", ["-E", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The command line of a live process — `/proc/<pid>/cmdline` on Linux. */
function commandLineOf(pid) {
  if (ON_LINUX) {
    return readFileSync(`/proc/${pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .join(" ");
  }
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A concrete free port. `resolveConfig` rejects 0 on purpose — the agent step
 * has to know the port up front, so "pick an ephemeral one" is never valid
 * wiring — which means these subprocess tests need a real one.
 */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("a RUNTIME scrub does not satisfy the guard — only an exec-time absence does", async () => {
  const { Readable } = await import("node:stream");
  const base = {
    SENTRY_MCP_BROKER_HANDLE: HANDLE,
    SENTRY_MCP_BROKER_PORT: "9401",
  };
  // The tempting wrong fix: the variable is gone from live process.env, but the
  // exec-time block — what /proc/<pid>/environ serves — still has it.
  const liveEnvHadItDeleted = { ...base };
  const execTimeEnv = { ...base, SENTRY_TRIAGE_TOKEN: REAL_CRED };
  assert.ok(!("SENTRY_TRIAGE_TOKEN" in liveEnvHadItDeleted));

  await assert.rejects(
    () =>
      resolveRuntime({
        envAtExec: execTimeEnv,
        stdin: Readable.from([REAL_CRED]),
      }),
    /exec-time environment as SENTRY_TRIAGE_TOKEN/,
    "scrubbing at runtime must not make the guard pass — /proc keeps the exec-time block",
  );

  // And the clean wiring resolves.
  const config = await resolveRuntime({
    envAtExec: base,
    stdin: Readable.from([`${REAL_CRED}\n`]),
  });
  assert.equal(config.token, REAL_CRED);
  assert.equal(config.port, 9401);
});

test("the Linux reader decodes a real /proc/<pid>/environ block", () => {
  // Runs on every platform: the decoding half of the Linux branch, which the
  // macOS host cannot exercise through an actual file read.
  const block = Buffer.from(
    `PATH=/usr/bin\0SENTRY_MCP_BROKER_HANDLE=${HANDLE}\0SENTRY_TRIAGE_TOKEN=${REAL_CRED}\0`,
    "utf8",
  );
  const decoded = decodeProcBlock(block);
  assert.ok(decoded.includes(`SENTRY_TRIAGE_TOKEN=${REAL_CRED}`));
  assert.ok(decoded.includes("SENTRY_MCP_BROKER_HANDLE"));
  // Entries must not run together, or a leak could hide across a boundary.
  assert.deepEqual(decoded.split("\n").slice(0, 2), [
    "PATH=/usr/bin",
    `SENTRY_MCP_BROKER_HANDLE=${HANDLE}`,
  ]);
  // An empty block decodes to something falsy-ish, which is exactly why the
  // reader throws on failure instead of returning a block it never read.
  assert.equal(decodeProcBlock(Buffer.alloc(0)), "");
});

test("POSITIVE CONTROL: an outsider reads a child's exec-time env, and a runtime delete does NOT clear it", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "delete process.env.PROBE_TOKEN; setTimeout(() => {}, 4000);"],
    { env: { ...process.env, PROBE_TOKEN: REAL_CRED }, stdio: "ignore" },
  );
  try {
    await settle(500);
    // No try/catch: a reader that cannot run must fail this test, because every
    // negative result below is only worth what this positive result is worth.
    const seen = execEnvironOf(child.pid);
    assert.ok(
      seen.includes(REAL_CRED),
      `${READER} did not detect a token in a child's exec-time env; every assertion below is vacuous until it does`,
    );
    // Belt: prove the reader returns a populated block, not a lucky substring.
    assert.ok(
      seen.includes("PROBE_TOKEN"),
      `${READER} returned a block without the variable name — the reader is not reading what it claims`,
    );
  } finally {
    child.kill("SIGKILL");
  }
});

test("the broker, spawned the way the workflow spawns it, has NO token in its exec-time env", async () => {
  // The workflow's shape, reduced to its load-bearing parts: the token starts
  // in the step's environment, is copied to a shell-local, the exported name is
  // unset, and only then is node exec'd — with the value on stdin.
  const port = await freePort();
  const script = `
    set -euo pipefail
    tok="\${SENTRY_TRIAGE_TOKEN:-}"
    unset SENTRY_TRIAGE_TOKEN
    exec env \
      SENTRY_MCP_BROKER_HANDLE="${HANDLE}" \
      SENTRY_MCP_BROKER_PORT=${port} \
      SENTRY_MCP_BROKER_TTL_SECONDS=30 \
      node "${BROKER_PATH}" <<<"\${tok}"
  `;
  // Keep the live ChildProcess handle. A PID string can be reused after exit,
  // so it is not cleanup authority on Darwin.
  const child = spawn("bash", ["-c", script], {
    env: { ...process.env, SENTRY_TRIAGE_TOKEN: REAL_CRED },
    stdio: "ignore",
  });
  try {
    await settle(700);
    // Throws if the broker died or the read failed — never a soft null.
    const environ = execEnvironOf(child.pid);
    assert.ok(
      !environ.includes(REAL_CRED),
      `the token is in the broker's exec-time environment (read via ${READER}) — the agent could take it straight out of /proc`,
    );
    // The load-bearing sanity check on BOTH reader paths: without it, a reader
    // that returned an empty-but-successful block would pass the line above.
    assert.ok(
      environ.includes("SENTRY_MCP_BROKER_HANDLE"),
      `${READER} returned a block without the handle, so the absent token is not a real result`,
    );
    // /proc/<pid>/cmdline is readable the same way; the token is never an argv.
    assert.ok(
      !commandLineOf(child.pid).includes(REAL_CRED),
      "the token must never appear on the broker's command line",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  }
});

test("the broker REFUSES to start when the token is in its exec-time env", async () => {
  // The pre-fix wiring, and the regression tripwire: inheriting the token must
  // be a startup failure, not a silent leak.
  const child = spawn(process.execPath, [BROKER_PATH], {
    env: {
      ...process.env,
      SENTRY_TRIAGE_TOKEN: REAL_CRED, // the leak
      SENTRY_MCP_BROKER_HANDLE: HANDLE,
      SENTRY_MCP_BROKER_PORT: String(await freePort()),
      SENTRY_MCP_BROKER_TTL_SECONDS: "30",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(REAL_CRED);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));

  assert.equal(code, 1, "an inherited token must be a non-zero exit");
  assert.match(stderr, /exec-time environment as SENTRY_TRIAGE_TOKEN/);
  assert.match(stderr, /Do not scrub it at runtime/);
  assert.ok(
    !stderr.includes(REAL_CRED),
    "the refusal must not print the credential it is complaining about",
  );
});

test("the entry-point check survives a symlinked staging path", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, symlinkSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, "sentry-mcp-broker.mjs");

  // Same file, reached through a symlinked parent — the shape `$RUNNER_TEMP`
  // takes on any host where the temp root is a link. A raw string compare says
  // "not the entry point" here, node exits 0 having started nothing, and the
  // workflow reports a broker that died with an empty log.
  const root = mkdtempSync(join(tmpdir(), "broker-entry-"));
  const real = join(root, "real");
  mkdirSync(real);
  const staged = join(real, "sentry-mcp-broker.mjs");
  copyFileSync(source, staged);
  const linked = join(root, "linked");
  symlinkSync(real, linked);

  assert.equal(isEntryPoint(staged, `file://${staged}`), true);
  assert.equal(
    isEntryPoint(join(linked, "sentry-mcp-broker.mjs"), `file://${staged}`),
    true,
    "a symlinked invocation path must still count as the entry point",
  );
  assert.equal(isEntryPoint("", `file://${staged}`), false);
  assert.equal(
    isEntryPoint(join(root, "other.mjs"), `file://${staged}`),
    false,
  );
});

// ── the workflow wiring this broker exists to enable ────────────────────────

const WORKFLOW = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".github",
    "workflows",
    "sentry-triage-agent.yml",
  ),
  "utf8",
);

/** The agent job's block, from its key to the next job's. */
function triageJobBlock() {
  const start = WORKFLOW.indexOf("\n  triage:");
  const end = WORKFLOW.indexOf("\n  verdict:");
  assert.ok(
    start > 0 && end > start,
    "triage/verdict job boundaries not found",
  );
  return WORKFLOW.slice(start, end);
}

test("the triage job's env holds NO credential — the issue's Done means", () => {
  const job = triageJobBlock();
  const jobEnv = job.slice(
    job.indexOf("\n    env:"),
    job.indexOf("\n    steps:"),
  );
  assert.ok(jobEnv.length > 0, "the triage job's env: block was not found");
  assert.ok(
    !/SENTRY_TRIAGE_TOKEN/.test(jobEnv),
    "SENTRY_TRIAGE_TOKEN is back in the triage job's env — every step, including the agent's Bash, inherits it",
  );
  // Stronger and still true: nothing in job env comes from `secrets.` at all.
  assert.ok(
    !/secrets\./.test(jobEnv),
    `the triage job's env must reference no secret; found: ${jobEnv.trim()}`,
  );
  // The handle reaches the agent step through $GITHUB_ENV, minted per run.
  assert.match(
    job,
    /SENTRY_MCP_BROKER_HANDLE=\$\{handle\}" >> "\$\{GITHUB_ENV\}"/,
  );
});

test("the Sentry secret is scoped to the broker step alone", () => {
  const job = triageJobBlock();
  const uses = [...job.matchAll(/secrets\.SENTRY_TRIAGE_TOKEN/g)];
  assert.equal(
    uses.length,
    1,
    "the Sentry token must be read exactly once, by the broker step",
  );
  const brokerStep = job.slice(
    job.indexOf("- name: Start the Sentry credential broker"),
    job.indexOf("- name: Render triage prompt"),
  );
  assert.ok(brokerStep.length > 0, "the broker step was not found");
  assert.match(
    brokerStep,
    /SENTRY_TRIAGE_TOKEN: \$\{\{ secrets\.SENTRY_TRIAGE_TOKEN \}\}/,
  );
  // $GITHUB_ENV would hand the token to every later step, including the
  // agent's. Line-scoped, so the step's own declaration does not false-match.
  for (const line of brokerStep.split("\n")) {
    if (!line.includes("GITHUB_ENV")) continue;
    assert.ok(
      !/SENTRY_MCP_BROKER_TOKEN|SENTRY_TRIAGE_TOKEN/.test(line),
      `the token must never be written to $GITHUB_ENV: ${line.trim()}`,
    );
  }
});

test("the broker step drops the exported token BEFORE node is exec'd", () => {
  const job = triageJobBlock();
  const brokerStep = job.slice(
    job.indexOf("- name: Start the Sentry credential broker"),
    job.indexOf("- name: Render triage prompt"),
  );
  const unsetAt = brokerStep.indexOf("unset SENTRY_TRIAGE_TOKEN");
  const nodeAt = brokerStep.indexOf('node "${RUNNER_TEMP}');
  assert.ok(unsetAt > 0, "the broker step must unset the exported token");
  assert.ok(nodeAt > 0, "the broker step must spawn node");
  assert.ok(
    unsetAt < nodeAt,
    "the unset must precede the spawn — /proc/<pid>/environ is fixed at exec, so unsetting after is inert",
  );

  // Delivered on stdin from a bash BUILTIN: no env var, no argv, no temp file.
  assert.match(brokerStep, /printf '%s' "\$\{token\}" \| \\/);
  // A here-string or heredoc may materialise a temp file the agent can read.
  assert.ok(
    !/<<</.test(brokerStep) && !/<<\s*['"]?\w+/.test(brokerStep),
    "the token must not be delivered through a here-string or heredoc",
  );
  // And the token must never be a node argument.
  const nodeLine = brokerStep.slice(nodeAt, brokerStep.indexOf("\n", nodeAt));
  assert.ok(
    !/token/.test(nodeLine),
    `the token must not appear on node's command line: ${nodeLine.trim()}`,
  );
});

test("no step in this workflow interpolates a secret INTO a run: body", () => {
  // GitHub expands ${{ }} before writing the step script to $RUNNER_TEMP, so an
  // inline secret is plaintext on disk for the life of the job — same
  // same-UID-readable class as /proc. `env:` bindings are the safe channel:
  // the script holds only the variable name.
  for (const [, body] of WORKFLOW.matchAll(
    /\n {8}run: \|\n([\s\S]*?)(?=\n {6}- |\n {2}\w+:|$)/g,
  )) {
    const inline = [...body.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map(
      (m) => m[1],
    );
    for (const expression of inline) {
      assert.ok(
        !/(^|\W)secrets\./.test(expression),
        `a secret is interpolated into a run: body (plaintext on disk): ${expression}`,
      );
    }
  }
});

test("the broker port has ONE literal, shared by the broker and the agent step", () => {
  const job = triageJobBlock();
  const jobEnv = job.slice(
    job.indexOf("\n    env:"),
    job.indexOf("\n    steps:"),
  );
  const declared = /SENTRY_MCP_BROKER_PORT: "(\d+)"/.exec(jobEnv)?.[1];
  assert.ok(
    declared,
    "the triage job must pin the broker port once, in job env",
  );

  // The agent step must interpolate that same value, not restate it.
  const mcpConfig = /--mcp-config '([^']+)'/.exec(job)?.[1];
  assert.ok(
    mcpConfig.includes("127.0.0.1:${{ env.SENTRY_MCP_BROKER_PORT }}"),
    "--mcp-config must interpolate the job-level port, not hardcode one",
  );

  // And no second literal anywhere in the job.
  const steps = job.slice(job.indexOf("\n    steps:"));
  const strays = [...steps.matchAll(new RegExp(`\\b${declared}\\b`, "g"))];
  assert.equal(
    strays.length,
    0,
    `the port literal ${declared} is restated inside the job's steps; it must come from job env`,
  );
});

test("the broker runs the immutable staged copy, never the checkout", () => {
  const job = triageJobBlock();
  // Its runtime closure is itself — no relative imports to carry along.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "sentry-mcp-broker.mjs"),
    "utf8",
  );
  assert.equal(
    [...source.matchAll(/from\s+["'](\.\/[^"']+)["']/g)].length,
    0,
    "the broker grew a relative import; the staging step must carry it too",
  );
  const stagingBlock = job.slice(
    job.indexOf("Stage immutable agent tools"),
    job.indexOf("Start the Sentry credential broker"),
  );
  assert.ok(
    stagingBlock.includes("sentry-mcp-broker.mjs"),
    "the broker is not in the staging step's copy list",
  );
  assert.match(
    job,
    /node "\$\{RUNNER_TEMP\}\/sentry-triage-tools\/sentry-mcp-broker\.mjs"/,
  );
  assert.ok(
    !/node scripts\//.test(job),
    "the triage job must execute nothing from the agent-writable checkout",
  );
});

test("the broker starts BEFORE the agent — the job must still end with the agent", () => {
  const job = triageJobBlock();
  assert.ok(
    job.indexOf("- name: Start the Sentry credential broker") <
      job.indexOf("anthropics/claude-code-action@"),
    "the broker step must precede the agent",
  );
  const afterAgent = job.slice(job.indexOf("anthropics/claude-code-action@"));
  assert.ok(
    !/- name:|- uses:/.test(afterAgent),
    "no step may follow the agent — its bash would source a $GITHUB_ENV-injected BASH_ENV payload",
  );
});

test("the MCP config points at the loopback broker and carries only the handle", () => {
  const job = triageJobBlock();
  const mcpConfig = /--mcp-config '([^']+)'/.exec(job)?.[1];
  assert.ok(mcpConfig, "--mcp-config was not found in the agent step");
  const parsed = JSON.parse(mcpConfig);
  const sentry = parsed.mcpServers.sentry;
  assert.deepEqual(sentry.env, {
    SENTRY_ACCESS_TOKEN: "${SENTRY_MCP_BROKER_HANDLE}",
  });
  // `--insecure-http` is CLI-only; there is no env var for it.
  assert.ok(sentry.args.includes("--insecure-http"));
  const hostIndex = sentry.args.indexOf("--host");
  assert.ok(hostIndex >= 0, "--host must be passed in args");
  // The port comes from job env, not a second literal — see the drift test.
  assert.equal(
    sentry.args[hostIndex + 1],
    "127.0.0.1:${{ env.SENTRY_MCP_BROKER_PORT }}",
  );
  // SENTRY_HOST cannot carry a scheme, so it is gone with the token.
  assert.ok(!("SENTRY_HOST" in sentry.env));
});

// ── the MCP pre-flight probe (issue #1938) ──────────────────────────────────
//
// The probe exists because the failure it catches is SILENT: when the Sentry
// MCP server does not register, claude-code-action initialises without it and
// prints nothing, the agent reports its own blindness as a verdict, and the
// deterministic verdict job settles the stub on it. So these tests hold two
// things: the probe's own protocol handling, driven against a fake server the
// way the broker suite drives its stub Sentry rather than pulling the real
// package into CI; and the wiring that makes the probe run at all — staged,
// before the agent, against the same server spec the agent is handed.

/** Literal-match a value that carries regex metacharacters (`@`, `.`, `/`). */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A spawn() stand-in: an EventEmitter with the three streams, no process. */
function fakeMcpChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const control = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, control];
  child.killed = false;
  control.on("data", () => {
    child.killed = true;
  });
  return child;
}

/**
 * Answer the probe's requests the way a healthy MCP server would.
 * `tools` is what `tools/list` reports back.
 */
function respondLikeServer(child, tools) {
  let buffered = "";
  child.stdin.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: "sentry", version: "0.37.0" } } })}\n`,
        );
      } else if (message.method === "tools/list") {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: tools.map((name) => ({ name })) } })}\n`,
        );
      }
    }
  });
}

const PROBE_ENV = {
  SENTRY_MCP_SERVER_SPEC: "@sentry/mcp-server@0.37.0",
  SENTRY_MCP_BROKER_PORT: "9401",
  SENTRY_MCP_BROKER_HANDLE: "h".repeat(64),
};

test("the probe reports the toolset a healthy server registers", async () => {
  const child = fakeMcpChild();
  respondLikeServer(child, REQUIRED_TOOLS);
  const tools = await probeSentryToolset({
    env: PROBE_ENV,
    spawnFn: () => child,
  });
  assert.deepEqual(tools, REQUIRED_TOOLS);
  assert.ok(child.killed, "the probe must not leave the server running");
});

test("DEMONSTRATED FAILURE: an empty toolset is refused, and names what is missing", async () => {
  // This is the 2026-08-19 shape: the CLI came up, the server did not, and the
  // agent saw no Sentry tool at all. Before the probe this passed silently into
  // a needs-human verdict on seven stubs.
  const child = fakeMcpChild();
  respondLikeServer(child, []);
  await assert.rejects(
    probeSentryToolset({ env: PROBE_ENV, spawnFn: () => child }),
    (error) => {
      assert.match(error.message, /registered no usable toolset/);
      for (const name of REQUIRED_TOOLS)
        assert.ok(error.message.includes(name));
      return true;
    },
  );
});

test("a PARTIAL toolset is refused too — the missing names, not the present ones", async () => {
  const child = fakeMcpChild();
  respondLikeServer(child, ["find_organizations", "find_projects"]);
  await assert.rejects(
    probeSentryToolset({ env: PROBE_ENV, spawnFn: () => child }),
    (error) => {
      assert.match(
        error.message,
        /missing: search_issues, search_events, get_sentry_resource/,
      );
      return true;
    },
  );
});

test("a server that dies before answering fails closed, carrying its stderr", async () => {
  const child = fakeMcpChild();
  setImmediate(() => {
    child.stderr.write("npm error 404 Not Found");
    setImmediate(() => child.emit("exit", 1, null));
  });
  await assert.rejects(
    probeSentryToolset({ env: PROBE_ENV, spawnFn: () => child }),
    (error) => {
      assert.match(error.message, /exited before the handshake completed/);
      assert.match(error.message, /npm error 404/);
      return true;
    },
  );
});

test("a server that never answers times out rather than hanging the job", async () => {
  const child = fakeMcpChild(); // answers nothing
  await assert.rejects(
    probeSentryToolset({
      env: { ...PROBE_ENV, SENTRY_MCP_PROBE_TIMEOUT_MS: "40" },
      spawnFn: () => child,
    }),
    (error) => {
      assert.match(error.message, /did not complete the handshake within 40ms/);
      return true;
    },
  );
  assert.ok(child.killed, "a timed-out server must still be killed");
});

test("a spawn that never starts is reported as a start failure", async () => {
  const child = fakeMcpChild();
  setImmediate(() => child.emit("error", new Error("spawn npx ENOENT")));
  await assert.rejects(
    probeSentryToolset({ env: PROBE_ENV, spawnFn: () => child }),
    (error) => {
      assert.match(error.message, /could not start the Sentry MCP server/);
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
});

test("an initialize refusal is reported as a refusal, not a timeout", async () => {
  const child = fakeMcpChild();
  child.stdin.on("data", () => {
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "bad token" } })}\n`,
    );
  });
  await assert.rejects(
    probeSentryToolset({ env: PROBE_ENV, spawnFn: () => child }),
    (error) => {
      assert.match(error.message, /refused initialize/);
      return true;
    },
  );
});

test("npm chatter on stdout does not break the handshake", () => {
  // `npx -y` prints to stdout on a cold cache. A non-JSON line is noise, not a
  // protocol error: dropping the run over it would turn a working server red.
  const { messages, rest } = drainMessages(
    'npm warn exec fetching\n{"jsonrpc":"2.0","id":1,"result":{}}\n{"partial":',
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
  assert.equal(rest, '{"partial":');
});

test("missingTools accepts a server that namespaces its tool names", () => {
  assert.deepEqual(
    missingTools(["mcp__sentry__find_projects"], ["find_projects"]),
    [],
  );
  assert.deepEqual(missingTools(["find_projects_v2"], ["find_projects"]), [
    "find_projects",
  ]);
});

test("resolveProbeConfig fails loudly rather than defaulting a wiring value", () => {
  // Same rule the broker applies to its port: a default is a second source of
  // truth that disagrees only on a live run.
  assert.throws(
    () => resolveProbeConfig({}),
    /missing required environment: SENTRY_MCP_SERVER_SPEC, SENTRY_MCP_BROKER_PORT, SENTRY_MCP_BROKER_HANDLE/,
  );
  assert.throws(
    () => resolveProbeConfig({ ...PROBE_ENV, SENTRY_MCP_BROKER_PORT: "94o1" }),
    /must be an integer from 1 to 65535/,
  );
  // Same range the broker enforces on the same variable, so the two readers of
  // SENTRY_MCP_BROKER_PORT cannot disagree about what a valid wiring is.
  for (const port of ["0", "65536", "99999"]) {
    assert.throws(
      () => resolveProbeConfig({ ...PROBE_ENV, SENTRY_MCP_BROKER_PORT: port }),
      /must be an integer from 1 to 65535/,
      `port ${port} must be refused`,
    );
  }
  assert.equal(
    resolveProbeConfig({ ...PROBE_ENV, SENTRY_MCP_BROKER_PORT: "65535" })
      .args[3],
    "127.0.0.1:65535",
  );
  assert.throws(
    () =>
      resolveProbeConfig({ ...PROBE_ENV, SENTRY_MCP_PROBE_TIMEOUT_MS: "0" }),
    /must be a positive number/,
  );
});

test("the probe spawns the server the AGENT is given, argument for argument", () => {
  // A probe that passed against a different spec, port or transport than the
  // agent's own --mcp-config would be worse than no probe: it would certify a
  // server nobody runs. So derive both from the same job env and compare.
  const job = triageJobBlock();
  const sentry = JSON.parse(/--mcp-config '([^']+)'/.exec(job)[1]).mcpServers
    .sentry;
  const substituted = sentry.args.map((arg) =>
    arg
      .replace(
        "${{ env.SENTRY_MCP_SERVER_SPEC }}",
        PROBE_ENV.SENTRY_MCP_SERVER_SPEC,
      )
      .replace(
        "${{ env.SENTRY_MCP_BROKER_PORT }}",
        PROBE_ENV.SENTRY_MCP_BROKER_PORT,
      ),
  );
  const config = resolveProbeConfig(PROBE_ENV);
  assert.equal(config.command, sentry.command);
  assert.deepEqual(config.args, substituted);
});

test("the MCP server spec has ONE literal, shared by the probe and the agent step", () => {
  const job = triageJobBlock();
  const jobEnv = job.slice(
    job.indexOf("\n    env:"),
    job.indexOf("\n    steps:"),
  );
  const declared = /SENTRY_MCP_SERVER_SPEC: "([^"]+)"/.exec(jobEnv)?.[1];
  assert.ok(declared, "the triage job must pin the MCP server spec in job env");
  const steps = job.slice(job.indexOf("\n    steps:"));
  const strays = [
    ...steps.matchAll(new RegExp(escapeForRegExp(declared), "g")),
  ];
  assert.equal(
    strays.length,
    0,
    `the server spec ${declared} is restated inside the job's steps; it must come from job env`,
  );
});

test("every tool the probe REQUIRES is one the agent is allowed to call", () => {
  // The probe demanding a tool the allowlist withholds would red every run on a
  // grant the agent could not use anyway.
  const allowed = /--allowedTools '([^']+)'/.exec(triageJobBlock())?.[1] ?? "";
  for (const name of REQUIRED_TOOLS) {
    assert.ok(
      allowed.includes(`mcp__sentry__${name}`),
      `the probe requires ${name}, which is not in the agent's --allowedTools`,
    );
  }
});

test("the probe runs the immutable staged copy, before the agent", () => {
  const job = triageJobBlock();
  // Its only relative import is the shared marker helper. The staging step
  // carries the canonical helper under the probe's flat runtime directory.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "sentry-mcp-probe.mjs"),
    "utf8",
  );
  // Every relative form, not just `from "./x"`: a `../` specifier and a
  // side-effect `import "./x"` (which has no `from` at all) would each add a
  // file to the runtime closure that the staging step does not copy, and the
  // probe would then die inside the trusted step with ERR_MODULE_NOT_FOUND.
  assert.deepEqual(
    [
      ...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g),
    ].map((match) => match[1]),
    ["./mapped-command-process-identity.mjs"],
    "the probe import closure changed; update the immutable staging copy",
  );
  assert.match(
    source,
    /stdio:\s*inheritGateMarkerStdio\(\["pipe", "pipe", "pipe", "pipe"\]\)/,
    "the staged probe no longer inherits mapped-command marker descriptors",
  );
  const stagingBlock = job.slice(
    job.indexOf("Stage immutable agent tools"),
    job.indexOf("Start the Sentry credential broker"),
  );
  assert.ok(
    stagingBlock.includes("sentry-mcp-probe.mjs"),
    "the probe is not in the staging step's copy list",
  );
  assert.ok(
    stagingBlock.includes('scripts/gate/mapped-command-process-identity.mjs"'),
    "the probe's shared marker helper is not in the staging step's copy list",
  );
  assert.match(
    job,
    /node "\$\{RUNNER_TEMP\}\/sentry-triage-tools\/sentry-mcp-probe\.mjs"/,
  );
  // Before the agent is the only place it CAN go: this job must end with the
  // agent, so there is no post-hoc check available.
  const probeAt = job.indexOf(
    "- name: Verify the Sentry MCP toolset registers",
  );
  assert.ok(probeAt > 0, "the pre-flight probe step is missing from the job");
  assert.ok(
    probeAt > job.indexOf("- name: Start the Sentry credential broker"),
    "the probe must run AFTER the broker it points at",
  );
  assert.ok(
    probeAt < job.indexOf("anthropics/claude-code-action@"),
    "the probe must run BEFORE the agent it gates",
  );
});

test("a paginated tools/list is followed to the end", async () => {
  // A probe that read only the first page could report a required tool missing
  // that the server DOES expose — a false red that stops triage entirely, on
  // the one step allowed to stop it.
  const child = fakeMcpChild();
  const pages = [
    { tools: ["find_organizations", "find_projects"], nextCursor: "p2" },
    { tools: ["search_issues", "search_events"], nextCursor: "p3" },
    { tools: ["get_sentry_resource"] },
  ];
  const cursorsSeen = [];
  let buffered = "";
  child.stdin.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`,
        );
      } else if (message.method === "tools/list") {
        cursorsSeen.push(message.params?.cursor ?? null);
        const page = pages.shift();
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: page.tools.map((name) => ({ name })),
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            },
          })}\n`,
        );
      }
    }
  });

  const tools = await probeSentryToolset({
    env: PROBE_ENV,
    spawnFn: () => child,
  });
  assert.deepEqual(tools, REQUIRED_TOOLS);
  // The cursor is opaque and must go back verbatim, never parsed or rebuilt.
  assert.deepEqual(cursorsSeen, [null, "p2", "p3"]);
});

test("the probe routes cleanup through its supervisor control pipe", async () => {
  const child = fakeMcpChild();
  respondLikeServer(child, REQUIRED_TOOLS);
  const stopped = [];
  await probeSentryToolset({
    env: PROBE_ENV,
    spawnFn: () => child,
    stopFn: (c) => stopped.push(c),
  });
  assert.deepEqual(stopped, [child]);

  assert.equal(requestSupervisorStop(child), true);
  assert.equal(child.killed, true);

  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "sentry-mcp-probe.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /process\.kill\s*\(/,
    "Node must not signal a reusable numeric pid or process-group id",
  );
  assert.match(source, /kill -KILL -- "-\$\$"/);
});

test("the probe does not stop an already-reaped supervisor", async () => {
  for (const eventName of ["exit", "close"]) {
    const child = fakeMcpChild();
    const cleanupCalls = [];
    const result = listServerTools({
      command: "npx",
      args: ["fixture"],
      handle: HANDLE,
      timeoutMs: 1_000,
      spawnFn: () => child,
      stopFn: (...args) => cleanupCalls.push(args),
    });

    queueMicrotask(() => child.emit(eventName, 7, null));
    await assert.rejects(
      result,
      new RegExp(
        `the Sentry MCP server ${eventName === "exit" ? "exited" : "closed"} before the handshake completed`,
      ),
    );
    assert.deepEqual(
      cleanupCalls,
      [],
      `cleanup after ${eventName} tried to address a reaped supervisor`,
    );
  }
});

test("the live supervisor settles descendants on control EOF and target exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "sentry-mcp-supervisor-"));
  const children = [];
  try {
    const start = (mode) => {
      const leak = join(root, `${mode}-descendant-survived`);
      const script = `
( /bin/sleep 2; printf survived > "$1" ) &
if [ "$2" = eof ]; then
  printf 'ready\\n'
  while :; do :; done
fi
exit 0
`;
      const child = spawnServerSupervisor({
        command: "/bin/bash",
        args: ["-c", script, "supervisor-fixture", leak, mode],
        handle: HANDLE,
      });
      children.push(child);
      return { child, leak, closed: once(child, "close") };
    };

    const eof = start("eof");
    const targetExit = start("target-exit");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the supervisor EOF fixture did not start")),
        5_000,
      );
      eof.child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    eof.child.stdio[3].end();

    const [[, eofSignal], [, targetSignal]] = await Promise.all([
      eof.closed,
      targetExit.closed,
    ]);
    assert.equal(eofSignal, "SIGKILL");
    assert.equal(targetSignal, "SIGKILL");

    const leakDeadline = Date.now() + 6_000;
    for (;;) {
      assert.equal(existsSync(eof.leak), false);
      assert.equal(existsSync(targetExit.leak), false);
      const remaining = leakDeadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(100, remaining));
    }
  } finally {
    for (const child of children) requestSupervisorStop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live supervisor reports the target exit status before cleanup", async () => {
  const child = spawnServerSupervisor({
    command: "/bin/bash",
    args: ["-c", "exit 23"],
    handle: HANDLE,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [, signal] = await once(child, "close");
  assert.equal(signal, "SIGKILL");
  assert.match(
    stderr,
    /sentry-mcp-server-supervisor: target exited with status 23/u,
  );
});

test("verbose server stderr retains the supervisor target status", async () => {
  const targetScript =
    'process.stderr.write("server stderr head\\n" + "x".repeat(1_200) + "\\nserver stderr tail\\n"); process.exit(23);';
  await assert.rejects(
    listServerTools({
      command: process.execPath,
      args: ["-e", targetScript],
      handle: HANDLE,
      timeoutMs: 5_000,
    }),
    (error) => {
      const prefix = " — server stderr: ";
      const diagnosticStart = error.message.indexOf(prefix);
      assert.ok(diagnosticStart >= 0, "the probe omitted server stderr");
      const diagnostic = error.message.slice(diagnosticStart + prefix.length);
      assert.ok(
        diagnostic.length <= 800,
        `the bounded server stderr grew to ${diagnostic.length} characters`,
      );
      assert.match(diagnostic, /^server stderr head/u);
      assert.match(diagnostic, /\.\.\. server stderr truncated \.\.\./u);
      assert.match(
        diagnostic,
        /sentry-mcp-server-supervisor: target exited with status 23$/u,
      );
      return true;
    },
  );
});

test("the closure assertion catches every relative import form", () => {
  // The narrow `from "./x"` pattern this started as would miss both of these,
  // and either one silently breaks the probe inside the trusted step.
  const pattern = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
  for (const form of [
    'import { x } from "./sibling.mjs";',
    'import { x } from "../parent.mjs";',
    'import "./side-effect.mjs";',
    'const m = await import("./dynamic.mjs");',
  ]) {
    assert.equal(
      [...form.matchAll(pattern)].length,
      1,
      `the closure pattern missed: ${form}`,
    );
  }
  // node: builtins and bare specifiers are not relative and must not match.
  for (const form of [
    'import test from "node:test";',
    'import x from "some-package";',
  ]) {
    assert.equal(
      [...form.matchAll(pattern)].length,
      0,
      `false positive: ${form}`,
    );
  }
});

test("an annotation reason survives its newlines", () => {
  // A workflow command ends at the first newline, and the reason carries the
  // server's stderr — so an unencoded message would drop the part that says why.
  assert.equal(encodeAnnotation("a\nb"), "a%0Ab");
  assert.equal(encodeAnnotation("a\r\nb"), "a%0D%0Ab");
  // `%` first, or the escapes introduced above would be double-encoded.
  assert.equal(encodeAnnotation("100%\ndone"), "100%25%0Adone");
  assert.equal(encodeAnnotation(undefined), "");
});

test("the probe's entry-point check survives a symlinked staging path", async () => {
  // Sharper here than for the broker. The workflow runs the probe from a staged
  // copy under `$RUNNER_TEMP`; where that root is a symlink, a raw string
  // compare says "not the entry point", node exits 0 having probed nothing, and
  // the STEP GOES GREEN — so the agent starts unguarded and the fail-open this
  // whole PR closes walks through the check that was meant to close it.
  const { mkdtempSync, mkdirSync, copyFileSync, symlinkSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const here = dirname(fileURLToPath(import.meta.url));

  const root = mkdtempSync(join(tmpdir(), "probe-entry-"));
  const real = join(root, "real");
  mkdirSync(real);
  const staged = join(real, "sentry-mcp-probe.mjs");
  copyFileSync(join(here, "sentry-mcp-probe.mjs"), staged);
  const linked = join(root, "linked");
  symlinkSync(real, linked);

  assert.equal(probeIsEntryPoint(staged, `file://${staged}`), true);
  assert.equal(
    probeIsEntryPoint(join(linked, "sentry-mcp-probe.mjs"), `file://${staged}`),
    true,
    "a symlinked staging path must still count as the entry point",
  );
  assert.equal(probeIsEntryPoint("", `file://${staged}`), false);
  assert.equal(
    probeIsEntryPoint(join(real, "other.mjs"), `file://${staged}`),
    false,
    "a different file must not count as the entry point",
  );
});

test("the probe stays under the 600-line soft cap", () => {
  // scripts/ has no max-lines lint and the ADR 0065 watchlist reports rather
  // than blocks, so the cap in docs/pr-checklists/recurring-review-patterns.md
  // is only enforced by a test. This module is new; pin it before it drifts,
  // in the suite the gate routes it to.
  const lines = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "sentry-mcp-probe.mjs"),
    "utf8",
  ).split("\n").length;
  assert.ok(
    lines <= 600,
    `sentry-mcp-probe.mjs is ${lines} lines, over the 600 soft cap`,
  );
});

test("the prompt forbids posting a verdict when the toolset is gone", () => {
  // The deterministic guard above is the fence; this is the agent-side half of
  // the same rule, for a toolset lost AFTER the probe passed. Without it the
  // agent reports its blindness as needs-human and the verdict job settles the
  // stub on it (#1938).
  const prompt = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      ".github",
      "prompts",
      "sentry-triage.md",
    ),
    "utf8",
  );
  assert.match(prompt, /One failure is NOT a verdict/);
  assert.match(prompt, /post NOTHING and stop/);
});
