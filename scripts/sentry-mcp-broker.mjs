#!/usr/bin/env node
/**
 * The Sentry triage agent's credential broker (issue #1711).
 *
 * WHY THIS EXISTS. `.github/workflows/sentry-triage-agent.yml` used to put
 * `SENTRY_TRIAGE_TOKEN` in the triage job's env so the Sentry MCP server —
 * launched by the Claude CLI, inside the untrusted agent's own process tree —
 * could read it through a `${SENTRY_TRIAGE_TOKEN}` expansion in
 * `--mcp-config`. The agent's allow-listed Bash inherits that env, and the
 * agent writes its own shell commands, so bash expands and transforms `$VAR`
 * before any wrapper receives argv: `${TOKEN:0:4}x${TOKEN:4}` posts the whole
 * token with one removable character spliced in. No check inside
 * `sentry-triage-agent-comment.mjs` can close that — exact-value scanning is
 * the wrong layer when the adversary controls the shell. The only fix removes
 * the credential from the agent's environment.
 *
 * WHAT THIS DOES. A TRUSTED workflow step (which runs before the agent and
 * holds the token step-scoped) starts this loopback HTTP broker and mints an
 * opaque per-run HANDLE. The agent step gets the handle and no Sentry
 * credential at all. The MCP server is pointed at the broker with
 * `--host 127.0.0.1:<port> --insecure-http` and authenticates with the handle;
 * the broker validates the handle, swaps in the real token, and forwards to
 * Sentry over HTTPS.
 *
 * THE HANDLE IS NOT A SECOND SECRET, and that is load-bearing. It is worthless
 * outside this run and outside this process: the broker binds 127.0.0.1 ONLY
 * (see BIND_HOST — nothing makes the bind address configurable), the handle is
 * minted per run and never persisted, and the broker exits with the runner. So
 * a handle that escapes into a public queue comment buys an attacker nothing,
 * which is what makes the residual steering channel below survivable.
 *
 * THE STEERING CHANNEL, STATED PLAINLY — DO NOT DESIGN AS IF IT WERE CLOSED.
 * Three allow-listed tools (`find_projects`, `search_issues`, `search_events`)
 * take an agent-controlled `regionUrl`. The MCP server's `validateRegionUrl`
 * accepts the base host plus a hardcoded {sentry.io, us.sentry.io,
 * de.sentry.io}, keeps only the HOST, and re-applies its own protocol — which
 * is `http` under `--insecure-http`. So an agent that passes
 * `regionUrl: "https://us.sentry.io"` produces a real cleartext request to
 * `http://us.sentry.io/api/0/...` carrying its `Authorization` header,
 * bypassing this broker entirely. Verified against the real
 * `@sentry/mcp-server@0.37.0`. What leaks there is the HANDLE, not the token,
 * and the handle is worthless off-runner — that is the whole reason this is an
 * accepted residual rather than a hole. Sentry egress is NOT closed on the
 * runner and this design does not assume it is.
 *
 * THE REGION-URL REWRITE IS A CORRECTNESS FIX, not decoration. Sentry's own
 * organization payload carries `links.regionUrl: "https://us.sentry.io"`, and
 * both the MCP server's internal code (the `trace`/`span` resource path reads
 * the org first and follows that link) and its `find_organizations` output
 * ("the Region URL shown above is the `regionUrl` value for later tools") steer
 * off the broker with it. Verified: served upstream-shaped links, a `trace`
 * read made exactly ONE request to the broker and sent the rest to
 * `http://us.sentry.io`. So the broker rewrites `links.regionUrl` on
 * organization payloads to its own origin, which `validateRegionUrl` accepts as
 * the base host. `links.organizationUrl` is deliberately NOT rewritten: it is
 * the human-facing permalink base, and verdict comments carry real Sentry
 * links.
 *
 * THE LOG IS AGENT-READABLE. The workflow points this process's stdout at a
 * file under `$RUNNER_TEMP`, which the agent holds `Read` on. So nothing here
 * ever logs the token or the handle — only method, path, status and a refusal
 * reason. Keep it that way.
 *
 * THE PATH ALLOWLIST is the empirically derived closure of the tools the
 * workflow actually grants, GET only — see
 * `docs/notes/sentry-triage-pipeline.md` for how to re-derive it. Nothing in
 * the granted set mutates and `update_issue` is deliberately not granted, so a
 * non-GET request is refused outright rather than proxied. Bumping
 * `@sentry/mcp-server` means re-deriving this list: a path the broker refuses
 * fails the triage leg loudly (the log names the rejected path), it does not
 * silently degrade.
 */

import { timingSafeEqual } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * Loopback ONLY. This is the property that makes a leaked handle worthless off
 * the runner, so it is a constant with no env override — widening it would
 * silently convert the handle into a credential that travels.
 */
export const BIND_HOST = "127.0.0.1";

/** Sentry SaaS US region. Overridable only for tests via the env below. */
export const DEFAULT_UPSTREAM = "https://us.sentry.io";

/** Minimum handle length accepted at startup (32 bytes of hex = 64 chars). */
export const MIN_HANDLE_LENGTH = 32;

/**
 * One path segment. Deliberately excludes `%`, so no percent-encoded traversal
 * survives the match; every identifier the granted tools produce (org and
 * project slugs, numeric issue ids, SHORT-IDs, hex event/trace/replay ids,
 * monitor slugs, snapshot artifact ids and image file names) is in this set.
 */
const SEG = "[A-Za-z0-9._-]+";

const path = (pattern) => new RegExp(`^${pattern}$`);

/**
 * Every path the workflow's granted Sentry MCP tools produce, derived by
 * driving those tools against a capture server rather than guessed from tool
 * names. At `@sentry/mcp-server@0.37.0` the granted-and-existing tools are
 * `find_organizations`, `find_projects`, `search_issues`, `search_events` and
 * `get_sentry_resource` (the other five names in `--allowedTools` do not exist
 * at this version and are inert grants). `get_sentry_resource` is driven across
 * its whole `resourceType` enum and `search_events` across every dataset,
 * because the agent can reach all of them.
 */
export const ALLOWED_PATHS = [
  // find_organizations
  path("/api/0/organizations/"),
  // organization details — get_sentry_resource(trace|span) reads this first
  path(`/api/0/organizations/${SEG}/`),
  // find_projects
  path(`/api/0/organizations/${SEG}/projects/`),
  // search_issues; also the shortId lookup behind get_sentry_resource(event)
  path(`/api/0/organizations/${SEG}/issues/`),
  // get_sentry_resource(issue) and its enrichment reads
  path(`/api/0/organizations/${SEG}/issues/${SEG}/`),
  path(`/api/0/organizations/${SEG}/issues/${SEG}/events/latest/`),
  path(`/api/0/organizations/${SEG}/issues/${SEG}/events/${SEG}/`),
  path(`/api/0/organizations/${SEG}/issues/${SEG}/autofix/`),
  path(`/api/0/organizations/${SEG}/issues/${SEG}/external-issues/`),
  path(`/api/0/organizations/${SEG}/replay-count/`),
  // search_events (errors/spans/logs/profiles/metrics)
  path(`/api/0/organizations/${SEG}/events/`),
  path(`/api/0/organizations/${SEG}/events/validate/`),
  // search_events(dataset=replays) and get_sentry_resource(replay)
  path(`/api/0/organizations/${SEG}/replays/`),
  path(`/api/0/organizations/${SEG}/replays/${SEG}/`),
  // get_sentry_resource(trace|span)
  path(`/api/0/organizations/${SEG}/trace/${SEG}/`),
  path(`/api/0/organizations/${SEG}/trace-meta/${SEG}/`),
  // get_sentry_resource(ai_conversation|monitor|snapshot|snapshotImage)
  path(`/api/0/organizations/${SEG}/ai-conversations/${SEG}/`),
  path(`/api/0/organizations/${SEG}/monitors/${SEG}/`),
  path(`/api/0/organizations/${SEG}/preprodartifacts/snapshots/${SEG}/`),
  path(
    `/api/0/organizations/${SEG}/preprodartifacts/snapshots/${SEG}/images/${SEG}/`,
  ),
  // project resolution behind search_issues/search_events projectSlug
  path(`/api/0/projects/${SEG}/${SEG}/`),
];

/** Organization payloads whose `links.regionUrl` must point back at us. */
const ORGANIZATION_PATHS = [
  path("/api/0/organizations/"),
  path(`/api/0/organizations/${SEG}/`),
];

export function isAllowedPath(pathname) {
  return ALLOWED_PATHS.some((pattern) => pattern.test(pathname));
}

function isOrganizationPath(pathname) {
  return ORGANIZATION_PATHS.some((pattern) => pattern.test(pathname));
}

/** Constant-time handle comparison; a length mismatch is an early miss. */
export function handleMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extracts the bearer value from an Authorization header, or "". */
function bearer(header) {
  const match = /^Bearer (.+)$/.exec(String(header ?? ""));
  return match ? match[1] : "";
}

/**
 * Points every `links.regionUrl` in an organization payload at the broker, in
 * place, and returns the payload. Handles both the list and single-object
 * shapes Sentry returns. `links.organizationUrl` is left alone on purpose.
 */
export function rewriteRegionLinks(payload, brokerOrigin) {
  if (Array.isArray(payload)) {
    for (const entry of payload) rewriteRegionLinks(entry, brokerOrigin);
    return payload;
  }
  if (payload && typeof payload === "object") {
    const links = payload.links;
    if (links && typeof links === "object" && "regionUrl" in links) {
      links.regionUrl = brokerOrigin;
    }
  }
  return payload;
}

function deny(res, status, reason) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ detail: `sentry-mcp-broker: ${reason}` }));
  return { status, reason };
}

/**
 * Decides an inbound request. Handle first: an unauthenticated caller learns
 * nothing about the method or path policy.
 */
export function classify({ method, authorization, pathname }, handle) {
  if (!handleMatches(bearer(authorization), handle)) {
    return { status: 401, reason: "invalid run handle" };
  }
  if (method !== "GET") {
    return {
      status: 405,
      reason: `method ${method} is not proxied (read-only broker)`,
    };
  }
  if (!isAllowedPath(pathname)) {
    return { status: 403, reason: `path not allowed: ${pathname}` };
  }
  return null;
}

/**
 * Builds the broker's request handler.
 *
 * @param {object} config
 * @param {string} config.token real Sentry token, never sent to the client
 * @param {string} config.handle per-run handle the MCP server presents
 * @param {string} config.upstream upstream origin (https)
 * @param {number} config.timeoutMs upstream request timeout
 * @param {(url: string, init: object) => Promise<Response>} [config.fetchImpl]
 * @param {(line: string) => void} [config.log]
 * @returns {(req, res) => Promise<void>}
 */
export function createHandler(config) {
  const {
    token,
    handle,
    upstream,
    timeoutMs = 60_000,
    fetchImpl = fetch,
    log = (line) => console.log(line),
  } = config;
  let brokerOrigin = null;

  const handler = async (req, res) => {
    // A relative-URL parse resolves `..` segments before anything sees them.
    const url = new URL(req.url, `http://${BIND_HOST}`);
    const refusal = classify(
      {
        method: req.method,
        authorization: req.headers.authorization,
        pathname: url.pathname,
      },
      handle,
    );
    if (refusal) {
      log(
        `sentry-mcp-broker: DENY ${refusal.status} ${req.method} ${url.pathname} — ${refusal.reason}`,
      );
      deny(res, refusal.status, refusal.reason);
      return;
    }

    const target = new URL(`${url.pathname}${url.search}`, upstream);
    let upstreamRes;
    try {
      upstreamRes = await fetchImpl(target.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          // The whole point: the handle never leaves this process, the token
          // never enters the agent's.
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "user-agent": String(
            req.headers["user-agent"] ?? "sentry-mcp-broker",
          ),
        },
      });
    } catch (error) {
      log(
        `sentry-mcp-broker: UPSTREAM-ERROR ${url.pathname} — ${error instanceof Error ? error.message : String(error)}`,
      );
      deny(res, 502, "upstream request failed");
      return;
    }

    // Never relay a redirect: the MCP client would follow it with the handle,
    // off the broker and possibly in cleartext. Fail closed and loudly instead.
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      log(
        `sentry-mcp-broker: DENY 502 GET ${url.pathname} — upstream redirect (${upstreamRes.status}) not relayed`,
      );
      deny(res, 502, "upstream redirect not relayed");
      return;
    }

    const contentType = upstreamRes.headers.get("content-type") ?? "";
    let body = Buffer.from(await upstreamRes.arrayBuffer());

    if (
      upstreamRes.status === 200 &&
      contentType.includes("application/json") &&
      isOrganizationPath(url.pathname)
    ) {
      try {
        body = Buffer.from(
          JSON.stringify(
            rewriteRegionLinks(JSON.parse(body.toString("utf8")), brokerOrigin),
          ),
          "utf8",
        );
      } catch {
        // Unparsable JSON is relayed untouched; the MCP server's own schema
        // validation is the right place for that failure to surface.
        log(
          `sentry-mcp-broker: WARN ${url.pathname} — organization payload was not parsable JSON, relayed unmodified`,
        );
      }
    }

    const headers = { "content-type": contentType || "application/json" };
    // Relayed so cursor pagination keeps working if the granted tool set grows;
    // the MCP client reads only the `cursor="…"` value out of it.
    const link = upstreamRes.headers.get("link");
    if (link) headers.link = link;
    res.writeHead(upstreamRes.status, headers);
    res.end(body);
    log(
      `sentry-mcp-broker: GET ${url.pathname} -> ${upstreamRes.status} (${body.length}b)`,
    );
  };

  handler.setBrokerOrigin = (origin) => {
    brokerOrigin = origin;
  };
  return handler;
}

/**
 * Starts the broker on `port`. Binds loopback only.
 *
 * @returns {Promise<import("node:http").Server>}
 */
export async function startBroker(config) {
  const handler = createHandler(config);
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      config.log?.(`sentry-mcp-broker: HANDLER-ERROR ${error}`);
      if (!res.headersSent) deny(res, 500, "internal error");
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 0, BIND_HOST, resolve);
  });
  const { port } = server.address();
  // `validateRegionUrl` demands an https URL and accepts the base host; the MCP
  // client then keeps the host and re-applies its own (http) protocol, so this
  // https origin is what routes region-scoped reads back here.
  handler.setBrokerOrigin(`https://${BIND_HOST}:${port}`);
  return server;
}

function requireEnv(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function resolveConfig(env) {
  const token = requireEnv(env, "SENTRY_MCP_BROKER_TOKEN");
  const handle = requireEnv(env, "SENTRY_MCP_BROKER_HANDLE");
  if (handle.length < MIN_HANDLE_LENGTH) {
    throw new Error(
      `SENTRY_MCP_BROKER_HANDLE must be at least ${MIN_HANDLE_LENGTH} characters (got ${handle.length}); mint it with \`openssl rand -hex 32\``,
    );
  }
  const upstream = String(
    env.SENTRY_MCP_BROKER_UPSTREAM ?? DEFAULT_UPSTREAM,
  ).trim();
  if (!upstream.startsWith("https://")) {
    throw new Error(
      `SENTRY_MCP_BROKER_UPSTREAM must be https (got ${upstream})`,
    );
  }
  const port = Number(env.SENTRY_MCP_BROKER_PORT ?? 9401);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `SENTRY_MCP_BROKER_PORT must be a valid port (got ${port})`,
    );
  }
  // Bounds the credential's lifetime without a step after the agent — the
  // triage job must END with the agent (a later step's bash would source a
  // $GITHUB_ENV-injected BASH_ENV payload), so there is nowhere safe to run an
  // explicit stop. Default matches the job's 30-minute timeout.
  const ttlSeconds = Number(env.SENTRY_MCP_BROKER_TTL_SECONDS ?? 1800);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(
      `SENTRY_MCP_BROKER_TTL_SECONDS must be a positive integer (got ${ttlSeconds})`,
    );
  }
  return {
    token,
    handle,
    upstream,
    port,
    ttlSeconds,
    readyFile: String(env.SENTRY_MCP_BROKER_READY_FILE ?? "").trim(),
  };
}

async function main(env = process.env) {
  const config = resolveConfig(env);
  const server = await startBroker(config);
  const { port } = server.address();
  console.log(
    `sentry-mcp-broker: listening on ${BIND_HOST}:${port} -> ${config.upstream} (ttl ${config.ttlSeconds}s)`,
  );
  if (config.readyFile) writeFileSync(config.readyFile, `${port}\n`);
  setTimeout(() => {
    console.log("sentry-mcp-broker: TTL reached, exiting");
    process.exit(0);
  }, config.ttlSeconds * 1000);
}

/**
 * Entry-point check on REALPATHS, not the raw argv string. The workflow runs
 * this from an immutable staged copy under `$RUNNER_TEMP`, and a `$RUNNER_TEMP`
 * that traverses a symlink (macOS `/var` -> `/private/var`, for one) makes a
 * raw string compare fail — node would then exit 0 having started nothing, and
 * the workflow's readiness wait would report a broker that "exited before
 * becoming ready" with an empty log. Reproduced locally; do not simplify.
 */
export function isEntryPoint(argv1, moduleUrl) {
  if (!argv1) return false;
  const resolve = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  return resolve(argv1) === resolve(fileURLToPath(moduleUrl));
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error(`sentry-mcp-broker: ${error.message}`);
    process.exit(1);
  });
}
