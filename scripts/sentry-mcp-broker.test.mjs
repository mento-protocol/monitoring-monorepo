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
import { createServer } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_PATHS,
  BIND_HOST,
  classify,
  handleMatches,
  isAllowedPath,
  isEntryPoint,
  resolveConfig,
  rewriteRegionLinks,
  startBroker,
} from "./sentry-mcp-broker.mjs";

const HANDLE = "h".repeat(64);
const REAL_TOKEN = "sntrys_the_real_read_only_token_value";

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
    token: REAL_TOKEN,
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
      assert.equal(upstream.seen[0].authorization, `Bearer ${REAL_TOKEN}`);
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

// ── fail closed: redirects and upstream failures ─────────────────────────────

test("an upstream redirect is refused, never relayed", async () => {
  await withBroker(
    (_req, res) => {
      res.writeHead(302, {
        location: "https://us.sentry.io/api/0/organizations/",
      });
      res.end();
    },
    async ({ base }) => {
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
    token: REAL_TOKEN,
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

test("resolveConfig fails loudly on a missing or weak credential wiring", () => {
  const base = {
    SENTRY_MCP_BROKER_TOKEN: REAL_TOKEN,
    SENTRY_MCP_BROKER_HANDLE: HANDLE,
  };
  assert.deepEqual(resolveConfig(base).upstream, "https://us.sentry.io");
  assert.equal(resolveConfig(base).port, 9401);
  assert.equal(resolveConfig(base).ttlSeconds, 1800);

  assert.throws(
    () => resolveConfig({ ...base, SENTRY_MCP_BROKER_TOKEN: "  " }),
    /SENTRY_MCP_BROKER_TOKEN is required/,
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
    /SENTRY_MCP_BROKER_TOKEN: \$\{\{ secrets\.SENTRY_TRIAGE_TOKEN \}\}/,
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
  assert.match(sentry.args[hostIndex + 1], /^127\.0\.0\.1:\d+$/);
  // SENTRY_HOST cannot carry a scheme, so it is gone with the token.
  assert.ok(!("SENTRY_HOST" in sentry.env));
});
