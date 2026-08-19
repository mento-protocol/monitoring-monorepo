#!/usr/bin/env node
/**
 * Show sync status for an Envio indexer deployment. Read-only: it reads the
 * Envio Cloud API through the `envio-cloud` CLI and never mutates anything, so
 * it does not source `lib/deploy-guard.sh` and is not a subject of
 * `check-deploy-root-anchors.test.mjs`.
 *
 * Usage:
 *   pnpm deploy:indexer:status                  → show latest deployment status
 *   pnpm deploy:indexer:status <commit>         → show specific deployment status
 *   pnpm deploy:indexer:status <commit> --watch → wait for registration, then poll until synced
 *   pnpm deploy:indexer:status <commit> --watch --compact → lower-noise watch output
 *   pnpm deploy:indexer:status --json           → JSON output
 *
 * Requires: workspace envio-cloud CLI dependency
 *
 * Every rendering, cadence and argument decision below is a pure function so
 * `deploy-indexer-status.test.mjs` can pin it without reaching the network. The
 * only impure parts are the three CLI calls and the sleep.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENVIO_ORG = "mento-protocol";
export const ENVIO_INDEXER = "mento";

export const REGISTRATION_POLL_SECONDS = 30;
// Emit a louder warning once registration takes longer than this. 3 min is past
// the normal 2-min P50 but short enough to catch a broken webhook before the
// operator walks away — the diagnostic-vs-timeout split makes broken webhooks
// observable within minutes instead of buried under uniform "checking again".
export const REGISTRATION_WARN_SECONDS = 180;
export const SYNC_POLL_SECONDS = 10;

/** The syncing sentinel the shell version returned from its renderers. */
export const STILL_SYNCING = 10;

/**
 * Exit code for a child that never launched. `spawnSync` reports `status: null`
 * with `error` set; bash reported 127 for the same condition. It must not
 * collapse to 1, because 1 is the registration-timeout sentinel — a CLI that
 * cannot start would otherwise be announced as "did not register within 10
 * minutes" instead of "failed to resolve".
 */
export const SPAWN_FAILED = 127;

/**
 * Capture ceiling for a child's stdout. `spawnSync` defaults to 1 MiB and kills
 * the child past it; the shell's `$(...)` had no limit at all, so a deployment
 * list or status payload that simply grew would start failing — and failing
 * dishonestly, since a truncated capture surfaces as `status: null` and would
 * otherwise be reported as "could not launch". 64 MiB is far above any payload
 * this API returns while still bounding memory.
 */
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * Make a child that never produced a usable result explain itself. `spawnSync`
 * signals both "could not launch" and "exceeded maxBuffer" as `status: null`
 * with an `error`, and neither is self-describing from the exit code alone.
 */
export function spawnFailureLine(result, label) {
  if (result.status !== null && result.status !== undefined) return null;
  const reason =
    result.error?.message ?? "no exit status and no error reported";
  return `❌ ${label} did not complete: ${reason}`;
}

export const USAGE =
  "Usage: pnpm deploy:indexer:status [<commit>] [--watch] [--json] [--compact]";

/**
 * Parse argv the way the shell loop did: flags in any position, at most one
 * positional commit, a bare `--` ignored.
 *
 * Returns either {ok:true, args} or {ok:false, lines, exitCode} so the caller
 * owns the stream choice. The shell printed this particular error on STDOUT,
 * not stderr; that is preserved deliberately rather than silently improved,
 * because the deploy skills capture these streams separately.
 */
export function parseArgs(argv) {
  let commit = "";
  let watch = false;
  let json = false;
  let compact = false;

  for (const arg of argv) {
    if (arg === "--watch" || arg === "-w") {
      watch = true;
    } else if (arg === "--json" || arg === "-j") {
      json = true;
    } else if (arg === "--compact" || arg === "-c") {
      compact = true;
    } else if (arg === "--") {
      // ignored
    } else if (commit !== "") {
      return {
        ok: false,
        stdout: [`❌ Unexpected argument: ${arg}`, USAGE],
        stderr: [],
        exitCode: 1,
      };
    } else {
      commit = arg;
    }
  }

  return { ok: true, args: { commit, watch, json, compact } };
}

/**
 * The two argument-shape refusals the shell made after parsing, in the same
 * order. Both wrote to stderr.
 */
export function validate(args, env = process.env) {
  if (args.compact && !args.watch) {
    return {
      ok: false,
      stdout: [],
      stderr: ["❌ --compact requires --watch"],
      exitCode: 1,
    };
  }
  const fixed = env.ENVIO_SYNC_COMPACT_EMIT_SECONDS;
  if (fixed !== undefined && fixed !== "" && !/^[0-9]+$/.test(fixed)) {
    return {
      ok: false,
      stdout: [],
      stderr: [
        "❌ ENVIO_SYNC_COMPACT_EMIT_SECONDS must be an integer number of seconds",
      ],
      exitCode: 1,
    };
  }
  // The one deliberate divergence from the shell version. Bash evaluated this
  // override inside `(( ))`, where a non-numeric string is a bare word worth
  // zero — so `abc` and `Infinity` alike meant "time out immediately", reported
  // as "within 0 minutes". Carrying that into Node is worse than useless:
  // `Number("Infinity")` polls forever and `Number("abc")` gives up before the
  // first poll and says "within NaN minutes". Refuse instead, exactly as the
  // sibling override above already did.
  //
  // Only where it is read, though. `waitForRegistration` is the sole consumer,
  // and it runs only for `<commit> --watch`; refusing on every invocation would
  // break a plain read-only status run in a shell that merely happens to carry
  // a stale export, which the shell version never did.
  // All-digits is necessary but not sufficient: a long enough run of them still
  // overflows to Infinity through Number(), and `elapsed <= Infinity` is a loop
  // that never ends — the exact hang this refusal exists to prevent, reached by
  // a value that looks perfectly well-formed.
  const timeout = env.ENVIO_REGISTRATION_TIMEOUT_SECONDS;
  if (
    args.watch &&
    args.commit !== "" &&
    timeout !== undefined &&
    timeout !== "" &&
    (!/^[0-9]+$/.test(timeout) || !Number.isSafeInteger(Number(timeout)))
  ) {
    return {
      ok: false,
      stdout: [],
      stderr: [
        "❌ ENVIO_REGISTRATION_TIMEOUT_SECONDS must be an integer number of seconds",
      ],
      exitCode: 1,
    };
  }
  return { ok: true };
}

/**
 * Filesystem path of a module sitting next to this one.
 *
 * `fileURLToPath`, never `URL.pathname`: a file URL keeps percent-encoding, so
 * a checkout under a directory with a space or any other escaped character
 * yields `/work/My%20Project/...`, and the spawned child is not found — every
 * invocation fails on a machine whose only sin is a directory name.
 */
export function siblingPath(specifier, baseUrl) {
  return fileURLToPath(new URL(specifier, baseUrl));
}

/**
 * 10 min, not 30. Normal registration completes in 2-3 min after push; a 30-min
 * silent wait was almost always wrong — by the 10-min mark Envio's webhook is
 * either broken or their build queue is jammed, and waiting longer just burns
 * operator time. Override per-invocation by exporting
 * ENVIO_REGISTRATION_TIMEOUT_SECONDS.
 *
 * `Number` can still yield NaN here: `validate` refuses a non-digit override
 * only on `<commit> --watch`, the one path that reads this. Every other caller
 * computes the value and never uses it, so a malformed export produces an
 * unused NaN rather than a bad timeout.
 */
export function registrationTimeoutSeconds(env = process.env) {
  const raw = env.ENVIO_REGISTRATION_TIMEOUT_SECONDS;
  return raw === undefined || raw === "" ? 600 : Number(raw);
}

export function compactFixedEmitSeconds(env = process.env) {
  const raw = env.ENVIO_SYNC_COMPACT_EMIT_SECONDS;
  return raw === undefined || raw === "" ? "" : raw;
}

// ---------------------------------------------------------------------------
// Pure row maths. Kept identical to the shell renderers' arithmetic, including
// the `Math.max(denominator, 1)` guard that stops a zero-width range dividing
// by zero on a deployment whose head has not advanced past its start block.
// ---------------------------------------------------------------------------

export function rowsOf(statusJson) {
  return statusJson?.data ?? [];
}

export function progressParts(row) {
  const start = Number(row.start_block ?? 0);
  const head = Number(row.block_height ?? 0);
  const processed = Number(row.latest_processed_block ?? 0);
  return {
    start,
    head,
    processed,
    denominator: Math.max(head - start, 1),
    numerator: Math.max(Math.min(processed, head) - start, 0),
  };
}

export function percentOf(row) {
  const { numerator, denominator } = progressParts(row);
  return (numerator / denominator) * 100;
}

export function isCaughtUp(row) {
  return (
    Number(row.latest_processed_block ?? 0) >= Number(row.block_height ?? 0)
  );
}

export function allCaughtUp(rows) {
  return rows.length > 0 && rows.every(isCaughtUp);
}

/**
 * Watch cadence, in seconds, as a function of overall progress: poll hard only
 * when the tail is close. Caught up is 0 because the watch exits.
 */
export function cadenceFor(overallPct, caughtUp) {
  if (caughtUp) return 0;
  if (overallPct < 50) return 300;
  if (overallPct < 75) return 180;
  if (overallPct < 90) return 120;
  if (overallPct < 97) return 60;
  if (overallPct < 99.5) return 30;
  return 10;
}

const fmtPct2 = (value) => `${value.toFixed(2)}%`;
const fmtPct1 = (value) => `${value.toFixed(1)}%`;
const fmtNum = (value) => Number(value ?? 0).toLocaleString("en-US");

const WIDTHS = [8, 10, 14, 14, 10, 10, 20];
const pad = (value, width) => String(value).padEnd(width, " ");
const line = (cells) => cells.map((cell, i) => pad(cell, WIDTHS[i])).join("  ");

/**
 * The full terminal table. Returns the lines plus the sentinel so the caller
 * decides the exit code, rather than calling process.exit from a renderer.
 */
export function renderTable(statusJson) {
  const rows = rowsOf(statusJson);
  const out = [];
  out.push(
    line([
      "CHAIN",
      "CATCH-UP",
      "START",
      "HEAD",
      "PROCESSED",
      "EVENTS",
      "SYNCED AT",
    ]),
  );
  out.push(
    line([
      "-----",
      "--------",
      "-----",
      "----",
      "---------",
      "------",
      "---------",
    ]),
  );
  for (const row of rows) {
    out.push(
      line([
        row.chain_id,
        fmtPct2(percentOf(row)),
        fmtNum(row.start_block),
        fmtNum(row.block_height),
        fmtNum(row.latest_processed_block),
        fmtNum(row.num_events_processed),
        row.timestamp_caught_up_to_head_or_endblock
          ? row.timestamp_caught_up_to_head_or_endblock
              .replace("T", " ")
              .slice(0, 19)
          : "-",
      ]),
    );
  }

  // The overall line sums the RAW spans, so a chain whose head has not moved
  // past its start contributes 0 rather than the per-row `1` floor.
  const parts = rows.map(progressParts);
  const totalDenominator = Math.max(
    parts.reduce((sum, part) => sum + Math.max(part.head - part.start, 0), 0),
    1,
  );
  const totalNumerator = parts.reduce((sum, part) => sum + part.numerator, 0);
  const caughtUp = allCaughtUp(rows);
  out.push("");
  out.push(
    `Overall catch-up: ${fmtPct2((totalNumerator / totalDenominator) * 100)} (${fmtNum(totalNumerator)}/${fmtNum(totalDenominator)} blocks since start)`,
  );
  out.push(`Status: ${caughtUp ? "caught up" : "syncing"}`);
  return { lines: out, status: caughtUp ? 0 : STILL_SYNCING };
}

/**
 * The low-noise watch line, plus the cadence and the state string the watch
 * loop gates emissions on. Gating on `state` rather than the whole line is what
 * keeps a moving block counter from emitting on every poll.
 */
export function renderCompact(statusJson) {
  const rows = rowsOf(statusJson);
  const parts = rows.map(progressParts);
  const totalDenominator = Math.max(
    parts.reduce((sum, part) => sum + Math.max(part.head - part.start, 0), 0),
    1,
  );
  const totalNumerator = parts.reduce((sum, part) => sum + part.numerator, 0);
  const caughtUp = allCaughtUp(rows);
  const overallPct = (totalNumerator / totalDenominator) * 100;
  const cadenceSeconds = cadenceFor(overallPct, caughtUp);
  const chainSummary = rows
    .map((row, index) => {
      const part = parts[index];
      return `${row.chain_id}:${fmtPct1((part.numerator / part.denominator) * 100)}(${fmtNum(part.processed)}/${fmtNum(part.head)})`;
    })
    .join(" ");
  const chainState = rows
    .map(
      (row) => `${row.chain_id}:${isCaughtUp(row) ? "caught_up" : "syncing"}`,
    )
    .join(" ");
  return {
    line: `status=${caughtUp ? "caught_up" : "syncing"} overall=${fmtPct1(overallPct)} cadence=${cadenceSeconds}s chains=${chainSummary}`,
    cadenceSeconds,
    state: `status=${caughtUp ? "caught_up" : "syncing"} cadence=${cadenceSeconds}s chains=${chainState}`,
    status: caughtUp ? 0 : STILL_SYNCING,
  };
}

/**
 * Should the compact watch print this poll? First line always; then on any
 * state change, on cadence expiry, or on the final caught-up render.
 */
export function shouldEmitCompact({
  lastEmitAt,
  now,
  state,
  lastState,
  cadenceSeconds,
  renderStatus,
}) {
  return (
    lastEmitAt === 0 ||
    state !== lastState ||
    now - lastEmitAt >= cadenceSeconds ||
    renderStatus === 0
  );
}

export function registrationPendingLine(target, elapsed, { compact, warned }) {
  if (compact) {
    return elapsed === 0
      ? `registration status=pending commit=${target} elapsed=${elapsed}s poll=${REGISTRATION_POLL_SECONDS}s`
      : null;
  }
  // Keep the warning context visible in scroll-back so the operator doesn't
  // lose track of the suspect state once the polling line restarts and the
  // diagnostic block scrolls off.
  return warned
    ? `⏳ Deployment ${target} not registered yet (${elapsed}s elapsed; webhook suspect — see warning above); checking again in ${REGISTRATION_POLL_SECONDS}s...`
    : `⏳ Deployment ${target} not registered yet (${elapsed}s elapsed); checking again in ${REGISTRATION_POLL_SECONDS}s...`;
}

export function slowRegistrationWarning(target, elapsed, timeoutSeconds) {
  return [
    "",
    `⚠️  Deployment ${target} still unregistered after ${elapsed}s — that's past the normal P50 of ~2 min.`,
    "   Likely causes (check before waiting longer):",
    "     • Envio already has 3 live deployments; delete a stale non-prod deployment first",
    "     • Envio Cloud's webhook receiver lost the push event (their side, opaque to us)",
    "     • Push was a no-op (same SHA already on the deploy branch — see deploy-indexer.sh warning)",
    "     • Envio's build queue is backed up",
    `   Inspect: https://envio.dev/app/${ENVIO_ORG}/${ENVIO_INDEXER}`,
    `   Will keep polling until ${timeoutSeconds}s then give up.`,
    "",
  ];
}

export function registrationTimeoutLines(target, timeoutSeconds) {
  return [
    `❌ Deployment ${target} did not register within ${Math.trunc(timeoutSeconds / 60)} minutes.`,
    "   First check active deployment count: 3 live deployments means Envio has no room for a new one.",
    "   If fewer than 3 deployments exist, treat this as an Envio-side issue (broken webhook, stuck build queue).",
    "   The push to the deploy branch succeeded — verify on GitHub and check Envio's UI:",
    `   https://envio.dev/app/${ENVIO_ORG}/${ENVIO_INDEXER}`,
  ];
}

export function unresolvedDeploymentLines(target) {
  return [
    `❌ Deployment ${target} not found for ${ENVIO_ORG}/${ENVIO_INDEXER}`,
    "   Envio deployment ids are short commit hashes and may lag after pushing to the deploy branch.",
    "   Re-run with --watch to wait for registration.",
  ];
}

// ---------------------------------------------------------------------------
// Impure edges.
// ---------------------------------------------------------------------------

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Run the CLI, capturing stdout and leaving stderr on the terminal.
 *
 * `stdio[2] = "inherit"` is the parity-critical part. The shell used
 * `$(pnpm exec envio-cloud …)`, which captures stdout ONLY — a warning the CLI
 * printed on a SUCCESSFUL call still reached the operator. Capturing stderr and
 * forwarding it only on failure silently swallows exactly those diagnostics,
 * and a status command that hides warnings is worse than one that is noisy.
 * Inheriting also keeps interleaving and TTY detection intact.
 */
function runCli(args, options = {}) {
  const result = spawnSync("pnpm", ["exec", "envio-cloud", ...args], {
    encoding: "utf8",
    // stdin inherited too: `$(...)` left the terminal attached, so an
    // envio-cloud that needs to prompt — an expired session asking the operator
    // to re-authenticate is the common case — could still read a reply. A piped
    // stdin nobody writes to turns that prompt into a hang or an EOF failure.
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: MAX_CAPTURE_BYTES,
    ...options,
  });
  const failure = spawnFailureLine(result, "envio-cloud");
  if (failure) process.stderr.write(`${failure}\n`);
  return result;
}

function deploymentListJson() {
  const result = runCli([
    "indexer",
    "get",
    ENVIO_INDEXER,
    ENVIO_ORG,
    "-o",
    "json",
  ]);
  return result;
}

function deploymentStatusJson(commit) {
  return runCli([
    "deployment",
    "status",
    ENVIO_INDEXER,
    commit,
    ENVIO_ORG,
    "-o",
    "json",
  ]);
}

/**
 * Resolve a target to a registered deployment commit through the same helper
 * the shell piped into: `resolve-envio-deployment.mjs` reads the deployment
 * list on stdin. An empty target means "latest".
 */
function resolveDeploymentCommit(target) {
  const list = deploymentListJson();
  if (list.status !== 0) {
    return { status: list.status ?? SPAWN_FAILED, commit: "" };
  }
  // stderr inherited for the same reason as the CLI calls: the shell piped only
  // stdout into this helper, so anything it warned about reached the operator
  // whether or not it then exited nonzero.
  const resolver = spawnSync(
    process.execPath,
    [siblingPath("./resolve-envio-deployment.mjs", import.meta.url), target],
    {
      input: list.stdout,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      maxBuffer: MAX_CAPTURE_BYTES,
    },
  );
  if (resolver.status !== 0) {
    const failure = spawnFailureLine(resolver, "resolve-envio-deployment.mjs");
    if (failure) process.stderr.write(`${failure}\n`);
    return { status: resolver.status ?? SPAWN_FAILED, commit: "" };
  }
  return { status: 0, commit: resolver.stdout.trim() };
}

async function waitForRegistration(target, { json, compact, timeoutSeconds }) {
  let elapsed = 0;
  let warned = false;

  while (elapsed <= timeoutSeconds) {
    const { status, commit } = resolveDeploymentCommit(target);
    // `timedOut` rather than a reserved exit code. A child that LAUNCHES and
    // exits 1 — unauthenticated envio-cloud, a network error, a resolver
    // rejecting malformed list JSON — is the common failure, and keying the
    // caller's message on the number would hand the operator the whole
    // three-live-deployments / broken-webhook block for an auth problem, and
    // hand it over instantly rather than after ten minutes.
    if (status !== 0) return { status, commit: "", timedOut: false };
    if (commit !== "") return { status: 0, commit, timedOut: false };

    if (!json) {
      if (elapsed >= REGISTRATION_WARN_SECONDS && !warned) {
        for (const l of slowRegistrationWarning(
          target,
          elapsed,
          timeoutSeconds,
        )) {
          process.stderr.write(`${l}\n`);
        }
        warned = true;
      } else {
        const pending = registrationPendingLine(target, elapsed, {
          compact,
          warned,
        });
        if (pending !== null) process.stderr.write(`${pending}\n`);
      }
    }

    await sleep(REGISTRATION_POLL_SECONDS);
    elapsed += REGISTRATION_POLL_SECONDS;
  }

  return { status: 1, commit: "", timedOut: true };
}

async function watchStatus(commit, { compact, fixedEmitSeconds }) {
  let lastState = "";
  let lastEmitAt = 0;

  for (;;) {
    const result = deploymentStatusJson(commit);
    if (result.status !== 0) {
      // No stderr forwarding: it was inherited, so the CLI already printed it.
      // The child's real code is passed through rather than flattened to 1, as
      // the shell did: 1 is the registration-timeout sentinel in this module, so
      // reusing it here would make a routine CLI failure indistinguishable from
      // a deployment that never registered.
      return result.status ?? SPAWN_FAILED;
    }
    const statusJson = JSON.parse(result.stdout || "{}");

    let renderStatus;
    if (compact) {
      const rendered = renderCompact(statusJson);
      renderStatus = rendered.status;
      let cadenceSeconds = rendered.cadenceSeconds;
      if (fixedEmitSeconds !== "") cadenceSeconds = Number(fixedEmitSeconds);

      const now = Math.floor(Date.now() / 1000);
      if (
        shouldEmitCompact({
          lastEmitAt,
          now,
          state: rendered.state,
          lastState,
          cadenceSeconds,
          renderStatus,
        })
      ) {
        const stamp = new Date().toTimeString().slice(0, 8);
        process.stdout.write(`${stamp} commit=${commit} ${rendered.line}\n`);
        lastState = rendered.state;
        lastEmitAt = now;
      }
    } else {
      process.stdout.write("\u001b[2J\u001b[H");
      process.stdout.write(
        `Deployment Metrics: ${ENVIO_ORG}/${ENVIO_INDEXER} (commit: ${commit})\n`,
      );
      process.stdout.write(
        `Last updated: ${new Date().toTimeString().slice(0, 8)}\n`,
      );
      process.stdout.write("\n");
      const rendered = renderTable(statusJson);
      renderStatus = rendered.status;
      for (const l of rendered.lines) process.stdout.write(`${l}\n`);
    }

    if (renderStatus === 0) return 0;
    if (renderStatus !== STILL_SYNCING) return renderStatus;

    if (!compact) {
      process.stdout.write("\n");
      process.stdout.write("Watching for updates. Press Ctrl+C to stop...\n");
    }
    await sleep(SYNC_POLL_SECONDS);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    for (const l of parsed.stdout) process.stdout.write(`${l}\n`);
    for (const l of parsed.stderr) process.stderr.write(`${l}\n`);
    return parsed.exitCode;
  }
  const args = parsed.args;

  const invalid = validate(args, env);
  if (!invalid.ok) {
    for (const l of invalid.stdout) process.stdout.write(`${l}\n`);
    for (const l of invalid.stderr) process.stderr.write(`${l}\n`);
    return invalid.exitCode;
  }

  const timeoutSeconds = registrationTimeoutSeconds(env);
  const fixedEmitSeconds = compactFixedEmitSeconds(env);
  let commit = args.commit;

  if (commit === "") {
    const resolved = resolveDeploymentCommit("");
    if (resolved.status !== 0) return resolved.status;
    commit = resolved.commit;
    if (commit === "") {
      process.stderr.write(
        `❌ No deployments found for ${ENVIO_ORG}/${ENVIO_INDEXER}\n`,
      );
      return 1;
    }
    if (!args.json) process.stdout.write(`📊 Latest deployment: ${commit}\n`);
  } else {
    const target = commit;
    if (args.watch) {
      const waited = await waitForRegistration(target, {
        json: args.json,
        compact: args.compact,
        timeoutSeconds,
      });
      if (waited.status !== 0) {
        const lines = waited.timedOut
          ? registrationTimeoutLines(target, timeoutSeconds)
          : [
              `❌ Failed to resolve deployment ${target} for ${ENVIO_ORG}/${ENVIO_INDEXER}`,
            ];
        for (const l of lines) process.stderr.write(`${l}\n`);
        return 1;
      }
      commit = waited.commit;
    } else {
      const resolved = resolveDeploymentCommit(target);
      if (resolved.status !== 0) return resolved.status;
      commit = resolved.commit;
      if (commit === "") {
        for (const l of unresolvedDeploymentLines(target)) {
          process.stderr.write(`${l}\n`);
        }
        return 1;
      }
    }
    if (!args.json) process.stdout.write(`📊 Deployment: ${commit}\n`);
  }

  if (!args.json) process.stdout.write("\n");

  if (args.watch) {
    if (args.json) {
      const result = runCli(
        [
          "deployment",
          "status",
          ENVIO_INDEXER,
          commit,
          ENVIO_ORG,
          "--watch-till-synced",
          "-o",
          "json",
        ],
        { stdio: "inherit", encoding: undefined },
      );
      return result.status ?? SPAWN_FAILED;
    }
    return watchStatus(commit, { compact: args.compact, fixedEmitSeconds });
  }

  const result = deploymentStatusJson(commit);
  if (result.status !== 0) {
    // No stderr forwarding: it was inherited, so the CLI already printed it.
    return result.status ?? SPAWN_FAILED;
  }
  if (args.json) {
    process.stdout.write(result.stdout);
    return 0;
  }
  const rendered = renderTable(JSON.parse(result.stdout || "{}"));
  for (const l of rendered.lines) process.stdout.write(`${l}\n`);
  // A one-shot run reports the state in its output; still-syncing is not a
  // failure of the command, so the sentinel collapses to 0 here. Only the watch
  // keeps it, because there "not caught up" means "keep going".
  return rendered.status === STILL_SYNCING ? 0 : rendered.status;
}

// `process.argv[1]` is undefined under `node -e` and some embedders, and
// pathToFileURL throws on undefined — so the guard checks it before resolving.
//
// realpathSync because Node's ESM loader realpaths the main entry while
// `pathToFileURL` only resolves it. Invoked through any symlinked component —
// a symlinked worktree, macOS `/tmp` → `/private/tmp` — the two hrefs differ,
// main() never runs, and the process exits 0 having printed nothing. A status
// command that silently reports success is the worst shape this could fail in.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
