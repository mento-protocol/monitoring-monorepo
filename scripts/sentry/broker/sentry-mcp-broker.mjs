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
 * THE TOKEN ARRIVES ON STDIN, AND EVERY OTHER CHANNEL LEAKS IT. GitHub Actions
 * runs every step as `runner`, and the agent holds `Read`, so any same-UID
 * readable surface is agent-reachable. Ruled out, each for a specific reason:
 *
 *   - PROCESS ENVIRONMENT. `/proc/<pid>/environ` is world-readable to the same
 *     UID, so inheriting the token from the step's `env:` block puts it one
 *     `Read` away — and the workflow logs this process's PID. THE SUBTLETY THAT
 *     MAKES THIS EASY TO FIX WRONGLY: that file is the environment captured at
 *     `exec`. `delete process.env.<name>` at runtime does not change it. Any
 *     scrub after start is theatre. The variable must not exist when this
 *     process is exec'd, which is why the workflow copies it to a shell-local
 *     and `unset`s the exported name BEFORE spawning node, and why
 *     `assertTokenAbsentFromExecEnv` refuses to start if it finds it anyway.
 *   - ARGV. `/proc/<pid>/cmdline` is readable the same way, so the token is
 *     never a process argument. The workflow writes it with `printf`, a bash
 *     BUILTIN — a builtin in a pipeline runs in a forked subshell that never
 *     `exec`s, so its `/proc/<pid>/cmdline` is the parent shell's command line,
 *     not the builtin's arguments. That is a property of fork-without-exec, not
 *     an accident worth relying on silently.
 *   - THE FILESYSTEM. A temp file is readable for as long as it exists. A
 *     pipeline uses an anonymous pipe and creates no file, unlike a here-string
 *     (`<<<`) or heredoc (`<<`), where bash may materialise one — do not
 *     "simplify" the pipe into either.
 *   - THE STEP SHELL'S OWN ENVIRONMENT still holds the token, and that is
 *     acceptable only because each `run:` step is its own process that has
 *     exited before the next step starts (the runner gates the next step on
 *     this one's exit code). The agent runs in a later step, so that process is
 *     gone. This broker deliberately outlives its step, which is exactly why
 *     ITS environment is the one that matters.
 *
 * RESIDUAL, UNVERIFIED: the token then lives in this process's heap. Reading
 * `/proc/<pid>/mem` needs `PTRACE_MODE_ATTACH`, which Yama's
 * `ptrace_scope=1` denies to a non-descendant same-user process — but the
 * runner's setting is not established. The broker step logs
 * `/proc/sys/kernel/yama/ptrace_scope` so the first real run settles it. Until
 * then, treat heap residency as unmitigated rather than safe.
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
 * The environment exactly as this process received it at `exec`, captured at
 * module load before anything can mutate `process.env`.
 *
 * This snapshot — not live `process.env` — is what `/proc/<pid>/environ`
 * contains for the life of the process. Never replace a use of this with
 * `process.env`, and never `delete process.env.<name>` anywhere in this file:
 * a runtime scrub leaves `/proc` untouched and only hides the leak from the
 * check that exists to find it.
 */
const ENV_AT_EXEC = Object.freeze({ ...process.env });

/**
 * Loopback ONLY. This is the property that makes a leaked handle worthless off
 * the runner, so it is a constant with no env override — widening it would
 * silently convert the handle into a credential that travels.
 */
export const BIND_HOST = "127.0.0.1";

/** Shortest value accepted as a Sentry token; real ones are far longer. */
export const MIN_TOKEN_LENGTH = 16;

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

/**
 * The upstream back-pressure headers this broker relays to its client.
 *
 * Sentry answers a throttled read with `Retry-After` and a family of
 * `X-Sentry-Rate-Limit-*` headers, and the MCP server is written to obey them.
 * Dropping them turns a 429 into a bare status: the client cannot tell how long
 * to wait, so it retries immediately against a Sentry already refusing it, and
 * the run burns its budget on requests none of which can succeed.
 *
 * A PREFIX allowlist, not a passthrough. The broker exists so that only what it
 * chose crosses it, and the two things named here carry no credential and no
 * routing — but a name-by-name list would silently drop whichever member of the
 * family Sentry adds next, which is the failure this fixes in the first place.
 */
const RATE_LIMIT_HEADER_PREFIX = "x-sentry-rate-limit";

export function isBackPressureHeader(name) {
  const lower = String(name ?? "").toLowerCase();
  return lower === "retry-after" || lower.startsWith(RATE_LIMIT_HEADER_PREFIX);
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
    // Back-pressure, relayed for the same reason (see isBackPressureHeader):
    // without it a 429 arrives stripped of every hint of when to try again.
    for (const [name, value] of upstreamRes.headers) {
      if (isBackPressureHeader(name)) headers[name.toLowerCase()] = value;
    }
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
    const onStartupError = (error) => reject(error);
    server.once("error", onStartupError);
    server.listen(config.port ?? 0, BIND_HOST, () => {
      server.removeListener("error", onStartupError);
      resolve();
    });
  });
  // Past startup that `reject` is a no-op, and it was the server's ONLY `error`
  // listener — so every later socket error was discarded in silence, which for a
  // broker whose whole job is to be the one path to Sentry reads as "the run
  // simply stopped getting answers". Log it instead. Nothing here throws: an
  // `error` event with no listener is an uncaught exception that would take the
  // broker down with the run still using it.
  server.on("error", (error) => {
    config.log?.(
      `sentry-mcp-broker: SERVER-ERROR ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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

/**
 * Reads the Sentry token from stdin — the channel that leaves no readable
 * trace. See the header for why every other channel does.
 *
 * The workflow pipes it from a bash builtin, so the value never becomes a
 * process argument and no temporary file is created. Stdin reaches EOF as soon
 * as the writer exits, and an anonymous pipe keeps no history, so once this
 * resolves the only copy left is this process's heap.
 */
export function readTokenFromStdin(stream = process.stdin, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (stream.isTTY) {
      reject(
        new Error(
          "the Sentry token must be piped on stdin (stdin is a TTY); the workflow pipes it from a bash builtin",
        ),
      );
      return;
    }
    let data = "";
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`no token arrived on stdin within ${timeoutMs}ms`));
    }, timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => {
      clearTimeout(timer);
      resolve(data.trim());
    });
    stream.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Refuses to start if the token is anywhere in the EXEC-TIME environment.
 *
 * This is the enforcement behind the header's central claim, and it must be
 * given the exec-time snapshot rather than live `process.env`. Deleting a
 * variable at runtime does NOT change `/proc/<pid>/environ` — that file is the
 * block captured at `exec` — so a check against live `process.env` would pass
 * for the exact wiring it exists to catch. Naming a variable here means the
 * workflow exported the token to this process and the fix belongs in the
 * workflow, not in a runtime scrub.
 */
export function assertTokenAbsentFromExecEnv(token, envAtExec) {
  for (const [name, value] of Object.entries(envAtExec)) {
    if (typeof value === "string" && value.includes(token)) {
      throw new Error(
        `the Sentry token is present in this process's exec-time environment as ${name}; ` +
          "any same-UID process can read it from /proc/<pid>/environ. " +
          "Do not scrub it at runtime — that does not change /proc. " +
          "Stop exporting it to this process (see the broker step in .github/workflows/sentry-triage-agent.yml).",
      );
    }
  }
}

export function resolveConfig(env) {
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
  // REQUIRED, not defaulted. The port is the contract between the broker step
  // and the agent step's --mcp-config, and it has exactly one literal: the
  // triage job's `env: SENTRY_MCP_BROKER_PORT`. A default here would be a
  // second source of truth that could silently disagree with the workflow and
  // surface only as a connection refused on a live run.
  const port = Number(requireEnv(env, "SENTRY_MCP_BROKER_PORT"));
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
    handle,
    upstream,
    port,
    ttlSeconds,
    readyFile: String(env.SENTRY_MCP_BROKER_READY_FILE ?? "").trim(),
  };
}

/**
 * Everything that must hold before a socket is bound: config from the
 * exec-time environment, token from stdin, and the exec-time env proven clean.
 *
 * `envAtExec` is a parameter so a test can hand in a snapshot that still holds
 * the token while live `process.env` no longer does — the exact shape of the
 * tempting wrong fix. Passing live `process.env` here instead would make that
 * case pass, which is why it is threaded through rather than read inline.
 */
export async function resolveRuntime({
  envAtExec = ENV_AT_EXEC,
  stdin = process.stdin,
} = {}) {
  const config = resolveConfig(envAtExec);
  const token = await readTokenFromStdin(stdin);
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `the token read from stdin is ${token.length} characters; expected at least ${MIN_TOKEN_LENGTH}`,
    );
  }
  // Before the socket binds, so a leaking wiring never serves a single request.
  assertTokenAbsentFromExecEnv(token, envAtExec);
  return { ...config, token };
}

async function main() {
  const config = await resolveRuntime();
  const server = await startBroker(config);
  const { port } = server.address();
  console.log(
    `sentry-mcp-broker: listening on ${BIND_HOST}:${port} -> ${config.upstream} (ttl ${config.ttlSeconds}s)`,
  );
  console.log(
    "sentry-mcp-broker: token read from stdin; absent from this process's exec-time environment",
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
