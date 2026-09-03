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
 * The module is pure logic plus a thin CLI shell. Its two-file import closure is
 * this module and `mapped-command-process-identity.mjs`: the workflow runs both
 * after setup-node with NO install, from immutable staged copies under
 * $RUNNER_TEMP, never from the agent-writable checkout. The suite in
 * sentry-mcp-broker.test.mjs pins both properties.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  closeReopenedGateMarkers,
  inheritGateMarkerStdio,
} from "./mapped-command-process-identity.mjs";

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

/** JSON-RPC id for `initialize`; `tools/list` pages take the ids after it. */
const INITIALIZE_ID = 1;

/**
 * Pagination stop. A server that returns a cursor forever would otherwise hold
 * the probe until its timeout with no explanation; this names the reason.
 */
const MAX_TOOL_PAGES = 20;

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
  // Same rule the broker applies to the same variable — it rejects anything
  // outside 1..65535 — so the two readers of SENTRY_MCP_BROKER_PORT cannot
  // disagree about what a valid wiring is. A digits-only check would accept
  // 65536 here and then fail as a connection error at a less obvious place.
  const portNumber = Number(port);
  if (
    !/^[0-9]+$/.test(port) ||
    !Number.isInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65535
  ) {
    throw new Error(
      `SENTRY_MCP_BROKER_PORT must be an integer from 1 to 65535, got "${port}"`,
    );
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

const MCP_SERVER_SUPERVISOR = String.raw`
set -u

# fd 3 belongs only to the Node parent and this watchdog. The target closes it.
# A stop line and parent-pipe EOF have the same meaning: settle the complete
# group while this detached supervisor still pins its own group id in $$.
(
  IFS= read -r _ <&3
  kill -KILL -- "-$$"
  exit 127
) &

"$@" 3<&- <&0 >&1 2>&2 &
target_pid=$!
wait "$target_pid"
target_status=$?

# A target can exit after it starts a grandchild. Settle the group before this
# live leader can be reaped and its numeric process-group id can be reused.
printf 'sentry-mcp-server-supervisor: target exited with status %s\n' "$target_status" >&2
kill -KILL -- "-$$"
exit 127
`;

/**
 * Start the target under a detached Bash process-group leader.
 *
 * The target inherits stdio 0-2. It does not inherit control fd 3. A watchdog
 * reads that descriptor and self-signals the process group on a stop request or
 * parent-pipe EOF while the supervisor is still the live group leader. The
 * supervisor applies the same live-leader group settlement if the target exits.
 */
export function spawnServerSupervisor({
  command,
  args,
  handle,
  spawnFn = spawn,
} = {}) {
  try {
    return spawnFn(
      "/bin/bash",
      [
        "-c",
        MCP_SERVER_SUPERVISOR,
        "sentry-mcp-server-supervisor",
        command,
        ...args,
      ],
      {
        stdio: inheritGateMarkerStdio(["pipe", "pipe", "pipe", "pipe"]),
        env: { ...process.env, SENTRY_ACCESS_TOKEN: handle },
        detached: true,
      },
    );
  } finally {
    // The supervisor holds its own copies from here. Releasing the parent's
    // keeps a probe that spawns more than once from accruing a descriptor per
    // marker per spawn, and runs even when the spawn threw.
    closeReopenedGateMarkers();
  }
}

/** Ask the live supervisor to settle its complete process group. */
export function requestSupervisorStop(child) {
  const control = child?.stdio?.[3];
  if (!control || control.destroyed || control.writableEnded) return false;
  try {
    control.on?.("error", () => {});
    control.end("stop\n");
    return true;
  } catch {
    return false;
  }
}

const MAX_SERVER_STDERR_CHARS = 800;
const SERVER_STDERR_TRUNCATION = "\n... server stderr truncated ...\n";

function boundedServerStderr(value) {
  const text = String(value ?? "").trim();
  if (text.length <= MAX_SERVER_STDERR_CHARS) return text;
  const contentBudget =
    MAX_SERVER_STDERR_CHARS - SERVER_STDERR_TRUNCATION.length;
  const headLength = Math.ceil(contentBudget / 2);
  const tailLength = contentBudget - headLength;
  return `${text.slice(0, headLength)}${SERVER_STDERR_TRUNCATION}${text.slice(-tailLength)}`;
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
  stopFn = requestSupervisorStop,
} = {}) {
  const child = spawnServerSupervisor({ command, args, handle, spawnFn });

  let settled = false;
  let stdout = "";
  let stderr = "";
  // `tools/list` may paginate; ids advance per page so a late reply to an
  // earlier page cannot be mistaken for the current one.
  let listId = INITIALIZE_ID + 1;
  let pages = 1;
  const collected = [];
  const send = (message) => {
    if (!child.stdin.destroyed)
      child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return await new Promise((resolve, reject) => {
    const finish = (fn, value, { childHasExited = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!childHasExited) stopFn(child);
      fn(value);
    };
    const fail = (reason, finishOptions) => {
      const stderrDiagnostic = boundedServerStderr(stderr);
      finish(
        reject,
        new Error(
          `${reason}${stderrDiagnostic ? ` — server stderr: ${stderrDiagnostic}` : ""}`,
        ),
        finishOptions,
      );
    };

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
        { childHasExited: true },
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      fail(
        `the Sentry MCP server closed before the handshake completed (code=${code}, signal=${signal})`,
        { childHasExited: true },
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
        if (message.id === INITIALIZE_ID) {
          if (message.error) {
            fail(
              `the Sentry MCP server refused initialize: ${JSON.stringify(message.error)}`,
            );
            return;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({
            jsonrpc: "2.0",
            id: listId,
            method: "tools/list",
            params: {},
          });
        } else if (message.id === listId) {
          if (message.error) {
            fail(
              `the Sentry MCP server refused tools/list: ${JSON.stringify(message.error)}`,
            );
            return;
          }
          collected.push(...toolNames(message.result));
          // FOLLOW PAGINATION. `tools/list` may split its result, and a probe
          // that read only the first page could report a required tool missing
          // that the server does in fact expose — a false RED that would stop
          // triage entirely, on the one step that is allowed to stop it. The
          // cursor is opaque: pass it back verbatim, never parse it.
          const cursor = message.result?.nextCursor;
          if (typeof cursor === "string" && cursor !== "") {
            if (++pages > MAX_TOOL_PAGES) {
              fail(
                `the Sentry MCP server paginated tools/list past ${MAX_TOOL_PAGES} pages`,
              );
              return;
            }
            listId += 1;
            send({
              jsonrpc: "2.0",
              id: listId,
              method: "tools/list",
              params: { cursor },
            });
            continue;
          }
          finish(resolve, collected);
          return;
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
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
  stopFn = requestSupervisorStop,
  required = REQUIRED_TOOLS,
} = {}) {
  const config = resolveProbeConfig(env);
  const tools = await listServerTools({ ...config, spawnFn, stopFn });
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

/**
 * True when this module is the process entry point (not an import).
 *
 * Compares REAL paths, the same way `sentry-mcp-broker.mjs` does and for a
 * sharper reason. The workflow runs this from a staged copy under
 * `$RUNNER_TEMP`, and on any host where that temp root is a symlink the string
 * node is invoked with and the one `import.meta.url` resolves to differ. A raw
 * compare then says "not the entry point", node exits 0 having run nothing —
 * and for THIS module that is a silent pass: the probe reports success without
 * probing, and the agent starts unguarded. The failure it exists to catch would
 * sail straight through the check meant to catch it.
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
  try {
    return resolve(argv1) === resolve(fileURLToPath(moduleUrl));
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
