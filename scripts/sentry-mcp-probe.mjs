#!/usr/bin/env node
/**
 * PRE-FLIGHT: PROVE THE SENTRY MCP TOOLSET REGISTERS BEFORE THE AGENT RUNS.
 *
 * The triage agent reaches Sentry through a stdio MCP server that
 * `claude-code-action` spawns for it. When that server fails to come up, the
 * CLI initialises WITHOUT it and prints nothing: no MCP error, no npm error, no
 * subprocess exit notice reaches the job log. The agent then has no
 * `mcp__sentry__*` tool at all, and — being an agent — it does the reasonable
 * thing and reports the situation as a verdict. The deterministic `verdict` job
 * cannot tell that comment apart from a judgement, so it applies the label,
 * strips `sentry:needs-triage`, and parks the stub as human work. A tooling
 * failure becomes a triage outcome (issue #1938).
 *
 * That is a FAIL-OPEN, and this module closes it. The workflow runs this probe
 * between the credential broker and the agent: it spawns the same pinned MCP
 * server against the same loopback broker, performs the MCP handshake, lists
 * the tools, and requires the read-only Sentry toolset to be present. A missing
 * toolset fails the JOB — before the agent burns a turn — so the stub keeps
 * `sentry:needs-triage` and the next round retries it. That is the same
 * fail-closed path a dead broker already takes, and the one the 2026-08-17..19
 * token outage exercised end to end.
 *
 * WHY BEFORE THE AGENT AND NOT AFTER: the triage job must END with the agent.
 * The agent can append `BASH_ENV=<payload it wrote>` to $GITHUB_ENV, and any
 * later step's bash would source that payload before its own command — an
 * escape from the whole permission allowlist. `sentry-triage-agent-comment.mjs`
 * asserts no step follows the agent, so a post-hoc check is not available here
 * even in principle.
 *
 * WHAT THIS PROBE DOES NOT CLAIM. `tools/list` is answered by the MCP server
 * itself and reaches neither the broker nor Sentry, so a green probe proves the
 * toolchain RESOLVES AND REGISTERS — `npx` fetched the pinned server, it
 * started, it speaks MCP, and the tools the agent's allowlist names exist. It
 * does not prove the Sentry credential works; broker readiness is the guard
 * that owns that, and an auth failure surfaces loudly as failed agent reads
 * rather than silently as an absent toolset. Widening the probe to a real
 * Sentry read would buy that at the cost of an API call per queue issue, on a
 * failure shape that is already loud.
 *
 * SIDE EFFECT, DELIBERATE AND LOAD-BEARING: the probe runs `npx` on the pinned
 * spec, so the agent's own spawn moments later is a cache hit rather than a
 * network fetch. The stall this issue was found through (~29.7s to CLI-ready,
 * against 6.8s on a run that worked) is unexplained; whatever its cause, paying
 * the fetch here — where a timeout is an honest job failure — is better than
 * paying it inside a startup window whose expiry is silent.
 *
 * The module is pure logic plus a thin CLI shell, and its import closure is
 * itself: the workflow runs it after setup-node with NO install, from the
 * immutable staged copy under $RUNNER_TEMP, never from the agent-writable
 * checkout. Both properties are pinned by tests in sentry-mcp-broker.test.mjs.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The Sentry tools the probe requires to be present.
 *
 * These are the five that actually EXIST at the pinned @sentry/mcp-server
 * version. The agent's `--allowedTools` names ten: the other five are inert
 * grants kept so a version bump that restores them does not silently lose the
 * grant (see the workflow's allowlist comment). Requiring the inert five here
 * would red every run; requiring none of them would let an empty toolset pass.
 * So the probe requires exactly the tools that must work today, and a test
 * pins this list as a SUBSET of the workflow's allowlist so the two cannot
 * drift apart in the direction that matters — a tool the probe demands but the
 * agent may not call.
 *
 * Re-derive on a version bump, per docs/notes/sentry-triage-pipeline.md.
 */
export const REQUIRED_TOOLS = [
  "find_organizations",
  "find_projects",
  "search_issues",
  "search_events",
  "get_sentry_resource",
];

/** MCP revision the handshake declares. */
export const PROTOCOL_VERSION = "2024-11-05";

/** Default ceiling for the whole handshake, generous enough for a cold `npx`. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Read the probe's configuration from the environment.
 *
 * Every value is REQUIRED rather than defaulted, for the reason the broker
 * gives about its own port: a default is a second source of truth that
 * disagrees only on a live run. The port and the server spec are the same two
 * job-level `env:` entries the agent step interpolates into `--mcp-config`, so
 * probe and agent cannot address different servers.
 */
export function resolveProbeConfig(env = process.env) {
  const spec = String(env.SENTRY_MCP_SERVER_SPEC ?? "").trim();
  const port = String(env.SENTRY_MCP_BROKER_PORT ?? "").trim();
  const handle = String(env.SENTRY_MCP_BROKER_HANDLE ?? "").trim();

  const missing = [];
  if (!spec) missing.push("SENTRY_MCP_SERVER_SPEC");
  if (!port) missing.push("SENTRY_MCP_BROKER_PORT");
  if (!handle) missing.push("SENTRY_MCP_BROKER_HANDLE");
  if (missing.length) {
    throw new Error(`missing required environment: ${missing.join(", ")}`);
  }
  if (!/^[0-9]+$/.test(port)) {
    throw new Error(`SENTRY_MCP_BROKER_PORT must be an integer, got "${port}"`);
  }

  const rawTimeout = String(env.SENTRY_MCP_PROBE_TIMEOUT_MS ?? "").trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `SENTRY_MCP_PROBE_TIMEOUT_MS must be a positive number, got "${rawTimeout}"`,
    );
  }

  return {
    command: "npx",
    // Byte-for-byte the agent's own `args`, so the probe cannot pass while the
    // agent's spawn fails on a difference in how it is invoked.
    args: ["-y", spec, "--host", `127.0.0.1:${port}`, "--insecure-http"],
    handle,
    timeoutMs,
  };
}

/** Split a stdio buffer into complete newline-delimited JSON messages. */
export function drainMessages(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const index = rest.indexOf("\n");
    if (index === -1) break;
    const line = rest.slice(0, index).trim();
    rest = rest.slice(index + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // A non-JSON line is npm/npx chatter on the same stream, not a protocol
      // error. Ignore it: the handshake is judged by the replies that DO parse,
      // and failing here would turn a noisy-but-working server into a red run.
    }
  }
  return { messages, rest };
}

/** The tool names in a `tools/list` result, whatever shape it arrived in. */
export function toolNames(result) {
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools
    .map((tool) => String(tool?.name ?? "").trim())
    .filter((name) => name !== "");
}

/**
 * Which required tools are absent.
 *
 * The server namespaces nothing — `mcp__sentry__` is the CLI's prefix, applied
 * on its side — so compare bare names and accept a prefixed one too rather than
 * red-lining a future server that starts qualifying them.
 */
export function missingTools(present, required = REQUIRED_TOOLS) {
  const names = new Set(present.map((name) => String(name)));
  const has = (want) =>
    names.has(want) || [...names].some((name) => name.endsWith(`__${want}`));
  return required.filter((want) => !has(want));
}

/**
 * Spawn the MCP server, handshake, and return its tool names.
 *
 * `spawnFn` is injected so the tests can drive the whole protocol against a
 * fixture server without pulling the real @sentry/mcp-server into CI — the same
 * trade the broker suite documents for its own end-to-end drive.
 */
export async function listServerTools({
  command,
  args,
  handle,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn = spawn,
} = {}) {
  const child = spawnFn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SENTRY_ACCESS_TOKEN: handle },
  });

  let settled = false;
  let stdout = "";
  let stderr = "";
  const send = (message) => {
    if (!child.stdin.destroyed)
      child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return await new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn(value);
    };
    const fail = (reason) =>
      finish(
        reject,
        new Error(
          `${reason}${stderr.trim() ? ` — server stderr: ${stderr.trim().slice(0, 800)}` : ""}`,
        ),
      );

    const timer = setTimeout(
      () =>
        fail(
          `the Sentry MCP server did not complete the handshake within ${timeoutMs}ms`,
        ),
      timeoutMs,
    );
    // The whole point of the probe is that this failure is silent inside the
    // agent's CLI. Unref nothing and let the timer hold the loop open.

    child.on("error", (error) =>
      fail(`could not start the Sentry MCP server: ${error.message}`),
    );
    // A server that dies mid-handshake makes the next write EPIPE. That is the
    // `exit` case, which reports the real reason with the server's stderr
    // attached — so swallow the write error rather than letting it crash the
    // probe with a less informative one.
    child.stdin.on("error", () => {});
    child.on("exit", (code, signal) => {
      if (settled) return;
      fail(
        `the Sentry MCP server exited before the handshake completed (code=${code}, signal=${signal})`,
      );
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const { messages, rest } = drainMessages(stdout);
      stdout = rest;
      for (const message of messages) {
        if (message.id === 1) {
          if (message.error) {
            fail(
              `the Sentry MCP server refused initialize: ${JSON.stringify(message.error)}`,
            );
            return;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          if (message.error) {
            fail(
              `the Sentry MCP server refused tools/list: ${JSON.stringify(message.error)}`,
            );
            return;
          }
          finish(resolve, toolNames(message.result));
          return;
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "sentry-triage-preflight", version: "1" },
      },
    });
  });
}

/**
 * The probe: resolve config, list the tools, require the read-only set.
 * Returns the tool names it saw; throws with a job-log-ready reason otherwise.
 */
export async function probeSentryToolset({
  env = process.env,
  spawnFn = spawn,
  required = REQUIRED_TOOLS,
} = {}) {
  const config = resolveProbeConfig(env);
  const tools = await listServerTools({ ...config, spawnFn });
  const missing = missingTools(tools, required);
  if (missing.length) {
    throw new Error(
      `the Sentry MCP server registered no usable toolset — missing: ${missing.join(", ")}; saw: ${tools.join(", ") || "(none)"}`,
    );
  }
  return tools;
}

/**
 * Encode a reason for a `::error::` workflow command.
 *
 * A workflow command ENDS at the first newline, and this reason usually carries
 * the MCP server's stderr — so an unencoded multi-line message would put its
 * first line in the annotation and spill the rest into the log as loose text,
 * losing exactly the part that says why the toolset never came up.
 */
export function encodeAnnotation(message) {
  return String(message ?? "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

/** True when this module is the process entry point (not an import). */
export function isEntryPoint(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return argv1 === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

async function main() {
  try {
    const tools = await probeSentryToolset({});
    console.log(`Sentry MCP toolset registered: ${tools.join(", ")}`);
  } catch (error) {
    console.log(
      `::error::Sentry MCP pre-flight failed; refusing to start the triage agent without its evidence source. ${encodeAnnotation(error.message)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  await main();
}
