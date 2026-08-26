#!/usr/bin/env node
/**
 * Pins the decisions the shell version encoded in argument parsing, renderer
 * arithmetic and watch cadence. The network edges are not covered here: they
 * are two `envio-cloud` calls with no logic of their own, and the parity of the
 * whole command against the shell original was established end to end with a
 * stubbed CLI when it was rewritten (see the PR).
 *
 * The cadence band cases exist because the end-to-end parity harness cannot
 * reach a syncing compact render — that watch never terminates — so a mutation
 * of a band threshold survived it. These are the layer that catches it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CAPTURE_BYTES,
  SPAWN_FAILED,
  STILL_SYNCING,
  USAGE,
  allCaughtUp,
  cadenceFor,
  compactFixedEmitSeconds,
  isCaughtUp,
  parseArgs,
  percentOf,
  progressParts,
  registrationPendingLine,
  registrationTimeoutLines,
  registrationTimeoutSeconds,
  renderCompact,
  renderTable,
  rowsOf,
  shouldEmitCompact,
  siblingPath,
  slowRegistrationWarning,
  spawnFailureLine,
  validate,
} from "./deploy-indexer-status.mjs";

// --- sibling module resolution ---------------------------------------------

// The resolver runs as a child process, so its path must be a filesystem path,
// not a URL pathname. `URL.pathname` keeps percent-encoding: under a checkout
// like `/work/My Project` it yields `My%20Project` and the child is never
// found, failing every invocation on a machine whose only sin is a directory
// name. This is the decode, pinned against a base URL that actually has one.
assert.equal(
  siblingPath(
    "./resolve-envio-deployment.mjs",
    "file:///work/My%20Project/scripts/deploy/deploy-indexer-status.mjs",
  ),
  "/work/My Project/scripts/deploy/resolve-envio-deployment.mjs",
);
assert.equal(
  siblingPath(
    "./resolve-envio-deployment.mjs",
    "file:///work/plain/scripts/deploy/deploy-indexer-status.mjs",
  ),
  "/work/plain/scripts/deploy/resolve-envio-deployment.mjs",
);
assert.ok(
  !siblingPath("./resolve-envio-deployment.mjs", import.meta.url).includes("%"),
  "the real resolver path must never carry percent-encoding",
);

// --- argument parsing ------------------------------------------------------

assert.deepEqual(parseArgs([]).args, {
  commit: "",
  watch: false,
  json: false,
  compact: false,
});
assert.equal(parseArgs(["abc1234"]).args.commit, "abc1234");
assert.equal(parseArgs(["--watch"]).args.watch, true);
assert.equal(parseArgs(["-w"]).args.watch, true);
assert.equal(parseArgs(["--json"]).args.json, true);
assert.equal(parseArgs(["-j"]).args.json, true);
assert.equal(parseArgs(["--compact"]).args.compact, true);
assert.equal(parseArgs(["-c"]).args.compact, true);

// Flags may precede or follow the commit, and a bare `--` is ignored rather
// than captured as the commit.
assert.equal(parseArgs(["--watch", "abc1234"]).args.commit, "abc1234");
assert.equal(parseArgs(["--", "abc1234"]).args.commit, "abc1234");
assert.equal(parseArgs(["abc1234", "--"]).args.commit, "abc1234");

// A second positional is a refusal, and it is reported on STDOUT — the shell
// original printed it without a redirect, and the deploy skills read the two
// streams separately, so moving it to stderr would be a silent contract change.
const extra = parseArgs(["abc1234", "def5678"]);
assert.equal(extra.ok, false);
assert.equal(extra.exitCode, 1);
assert.deepEqual(extra.stdout, ["❌ Unexpected argument: def5678", USAGE]);
assert.deepEqual(extra.stderr, []);

// --- validation ------------------------------------------------------------

const compactOnly = validate({ compact: true, watch: false }, {});
assert.equal(compactOnly.ok, false);
assert.deepEqual(compactOnly.stderr, ["❌ --compact requires --watch"]);
assert.equal(validate({ compact: true, watch: true }, {}).ok, true);
assert.equal(validate({ compact: false, watch: false }, {}).ok, true);

// Same rejects as the timeout override, including the all-digits value that
// overflows to Infinity: there it would disable the cadence branch of
// shouldEmitCompact, leaving the compact watch silent between state changes.
for (const bad of ["abc", "Infinity", "-5", "1.5", "1e3", "9".repeat(400)]) {
  const badCadence = validate(
    { compact: true, watch: true },
    { ENVIO_SYNC_COMPACT_EMIT_SECONDS: bad },
  );
  assert.equal(badCadence.ok, false, `${bad} must be refused`);
  assert.match(badCadence.stderr[0], /must be an integer number of seconds/);
}

// Mode scope, pinned in both directions. This refusal is the SHELL's own and
// sat at top level: `status <commit>` with a malformed export exited 1 there,
// whether or not compact watch was ever reached. It stays unnarrowed for that
// reason, unlike the timeout override below, whose refusal is new to this
// command and is therefore confined to the one path that reads it. Narrowing
// this one would quietly start accepting an export the command has always
// rejected, so pin every mode rather than leave it to the next reader's taste.
// Every mode the parser can actually produce, enumerated from `parseArgs` rather
// than hand-picked: the full cross product of "commit given or not" with plain,
// watch, and compact watch. `--compact` requires `--watch`, so compact:true
// without watch:true is not a reachable shape and is refused earlier.
//
// One list drives BOTH matrices below. Two hand-maintained lists is how the
// acceptance side came to cover four fewer modes than the refusal side while
// its comment claimed "every mode" — a mode-specific regression could have
// passed the suite through the gap.
const EVERY_MODE = [
  { compact: false, watch: false, commit: "" }, // status
  { compact: false, watch: false, commit: "abc1234" }, // status <commit>
  { compact: false, watch: true, commit: "" }, // status --watch
  { compact: false, watch: true, commit: "abc1234" }, // status <commit> --watch
  { compact: true, watch: true, commit: "" }, // status --watch --compact
  { compact: true, watch: true, commit: "abc1234" }, // status <commit> -w -c
];

for (const mode of EVERY_MODE) {
  assert.equal(
    validate(mode, { ENVIO_SYNC_COMPACT_EMIT_SECONDS: "abc" }).ok,
    false,
    `a malformed cadence export must be refused in every mode: ${JSON.stringify(mode)}`,
  );
}
// The same modes accept a well-formed value, so the refusal above is about the
// value and not about the mode.
for (const mode of EVERY_MODE) {
  assert.equal(
    validate(mode, { ENVIO_SYNC_COMPACT_EMIT_SECONDS: "45" }).ok,
    true,
    `a well-formed cadence export must be accepted: ${JSON.stringify(mode)}`,
  );
}
assert.equal(
  validate(
    { compact: true, watch: true },
    { ENVIO_SYNC_COMPACT_EMIT_SECONDS: "0" },
  ).ok,
  true,
);
// Unset and empty are both "not configured", not "invalid".
assert.equal(validate({ compact: true, watch: true }, {}).ok, true);
assert.equal(
  validate(
    { compact: true, watch: true },
    { ENVIO_SYNC_COMPACT_EMIT_SECONDS: "" },
  ).ok,
  true,
);

// A malformed registration timeout is refused rather than coerced. Bash read
// this override inside `(( ))`, where `abc` and `Infinity` are both worth zero,
// so the shell gave up before the first poll and said "within 0 minutes".
// Number() would instead poll forever on Infinity and print "NaN minutes".
// "9" x 400 is the one that looks well-formed: all digits, passes the regex,
// and still becomes Infinity through Number() — making `elapsed <= timeout` a
// loop with no end, which is precisely what this refusal exists to prevent.
for (const bad of ["abc", "Infinity", "-5", "1.5", "1e3", "9".repeat(400)]) {
  const refused = validate(
    { compact: false, watch: true, commit: "abc1234" },
    { ENVIO_REGISTRATION_TIMEOUT_SECONDS: bad },
  );
  assert.equal(refused.ok, false, `${bad} must be refused`);
  assert.match(
    refused.stderr[0],
    /ENVIO_REGISTRATION_TIMEOUT_SECONDS must be an integer number of seconds/,
  );
}
for (const good of ["0", "300", "600"]) {
  assert.equal(
    validate(
      { compact: false, watch: true, commit: "abc1234" },
      { ENVIO_REGISTRATION_TIMEOUT_SECONDS: good },
    ).ok,
    true,
    `${good} must be accepted`,
  );
}

// The refusal is deliberately narrowed to the only path that reads the value:
// `waitForRegistration`, which runs for `<commit> --watch`. Both halves of that
// narrowing are pinned, so a later widening back to every invocation is a
// visible decision rather than a quiet one.
assert.equal(
  validate(
    { compact: false, watch: false, commit: "abc1234" },
    { ENVIO_REGISTRATION_TIMEOUT_SECONDS: "10m" },
  ).ok,
  true,
  "a one-shot run never reads the timeout, so it must not refuse",
);
assert.equal(
  validate(
    { compact: false, watch: true, commit: "" },
    { ENVIO_REGISTRATION_TIMEOUT_SECONDS: "10m" },
  ).ok,
  true,
  "watching the latest deployment skips registration, so it must not refuse",
);
assert.equal(
  validate(
    { compact: false, watch: true, commit: "abc1234" },
    { ENVIO_REGISTRATION_TIMEOUT_SECONDS: "10m" },
  ).ok,
  false,
  "only the registration wait reads it, and there it must refuse",
);

// --- environment defaults --------------------------------------------------

assert.equal(registrationTimeoutSeconds({}), 600);
assert.equal(
  registrationTimeoutSeconds({ ENVIO_REGISTRATION_TIMEOUT_SECONDS: "300" }),
  300,
);
assert.equal(compactFixedEmitSeconds({}), "");
assert.equal(
  compactFixedEmitSeconds({ ENVIO_SYNC_COMPACT_EMIT_SECONDS: "45" }),
  "45",
);

// --- row arithmetic --------------------------------------------------------

assert.deepEqual(rowsOf({}), []);
assert.deepEqual(rowsOf({ data: [1] }), [1]);

// A head that has not advanced past start must not divide by zero.
const flat = {
  start_block: 1000,
  block_height: 1000,
  latest_processed_block: 1000,
};
assert.equal(progressParts(flat).denominator, 1);
assert.equal(percentOf(flat), 0);
assert.equal(isCaughtUp(flat), true);

// Processed beyond head is clamped, so catch-up cannot exceed 100%.
const ahead = {
  start_block: 100,
  block_height: 200,
  latest_processed_block: 999,
};
assert.equal(percentOf(ahead), 100);
assert.equal(isCaughtUp(ahead), true);

// Missing fields read as zero rather than NaN.
assert.equal(percentOf({}), 0);
assert.equal(isCaughtUp({}), true);

// An empty chain list is never "caught up" — there is nothing to be caught up.
assert.equal(allCaughtUp([]), false);
assert.equal(allCaughtUp([flat]), true);
assert.equal(
  allCaughtUp([
    flat,
    { start_block: 0, block_height: 10, latest_processed_block: 5 },
  ]),
  false,
);

// --- cadence bands ---------------------------------------------------------

assert.equal(cadenceFor(0, true), 0, "caught up stops the watch");
assert.equal(cadenceFor(0, false), 300);
assert.equal(cadenceFor(49.9, false), 300);
assert.equal(cadenceFor(50, false), 180);
assert.equal(cadenceFor(74.9, false), 180);
assert.equal(cadenceFor(75, false), 120);
assert.equal(cadenceFor(89.9, false), 120);
assert.equal(cadenceFor(90, false), 60);
assert.equal(cadenceFor(96.9, false), 60);
assert.equal(cadenceFor(97, false), 30);
assert.equal(cadenceFor(99.4, false), 30);
assert.equal(cadenceFor(99.5, false), 10);
assert.equal(cadenceFor(100, false), 10);

// --- renderers -------------------------------------------------------------

const syncing = {
  data: [
    {
      chain_id: 42220,
      start_block: 0,
      block_height: 1000000,
      latest_processed_block: 500000,
      num_events_processed: 4567890,
      timestamp_caught_up_to_head_or_endblock: null,
    },
  ],
};
const table = renderTable(syncing);
assert.equal(
  table.status,
  STILL_SYNCING,
  "a syncing render carries the sentinel",
);
assert.match(table.lines[0], /^CHAIN {5}CATCH-UP/);
assert.equal(
  table.lines.at(-2),
  "Overall catch-up: 50.00% (500,000/1,000,000 blocks since start)",
);
assert.equal(table.lines.at(-1), "Status: syncing");
// Thousands separators and a missing sync timestamp rendered as a dash.
assert.match(table.lines[2], /4,567,890/);
assert.match(table.lines[2], /-\s*$/);

const caughtUp = {
  data: [
    {
      chain_id: 1,
      start_block: 10,
      block_height: 20,
      latest_processed_block: 20,
      num_events_processed: 7,
      timestamp_caught_up_to_head_or_endblock: "2026-08-19T04:05:06.789Z",
    },
  ],
};
const doneTable = renderTable(caughtUp);
assert.equal(doneTable.status, 0);
assert.equal(doneTable.lines.at(-1), "Status: caught up");
// The ISO timestamp is shown as `YYYY-MM-DD HH:MM:SS`, seconds precision.
assert.match(doneTable.lines[2], /2026-08-19 04:05:06/);

// An empty chain list still renders a table and still reports syncing.
const emptyTable = renderTable({ data: [] });
assert.equal(emptyTable.status, STILL_SYNCING);
assert.equal(emptyTable.lines.at(-1), "Status: syncing");
assert.equal(
  emptyTable.lines.at(-2),
  "Overall catch-up: 0.00% (0/1 blocks since start)",
);

const compact = renderCompact(syncing);
assert.equal(compact.status, STILL_SYNCING);
assert.equal(
  compact.line,
  "status=syncing overall=50.0% cadence=180s chains=42220:50.0%(500,000/1,000,000)",
);
assert.equal(compact.cadenceSeconds, 180);
assert.equal(compact.state, "status=syncing cadence=180s chains=42220:syncing");

const compactDone = renderCompact(caughtUp);
assert.equal(compactDone.status, 0);
assert.equal(compactDone.cadenceSeconds, 0);
assert.equal(
  compactDone.state,
  "status=caught_up cadence=0s chains=1:caught_up",
);

// The state string carries no block counters, which is what lets the emission
// gate stay quiet while only the numbers move.
assert.equal(
  renderCompact({
    data: [
      {
        chain_id: 1,
        start_block: 0,
        block_height: 100,
        latest_processed_block: 10,
      },
    ],
  }).state,
  renderCompact({
    data: [
      {
        chain_id: 1,
        start_block: 0,
        block_height: 100,
        latest_processed_block: 11,
      },
    ],
  }).state,
);

// --- compact emission gate -------------------------------------------------

const gate = {
  lastEmitAt: 100,
  now: 105,
  state: "s",
  lastState: "s",
  cadenceSeconds: 60,
  renderStatus: STILL_SYNCING,
};
assert.equal(shouldEmitCompact(gate), false, "quiet inside the cadence window");
assert.equal(
  shouldEmitCompact({ ...gate, lastEmitAt: 0 }),
  true,
  "always emit the first line",
);
assert.equal(
  shouldEmitCompact({ ...gate, state: "t" }),
  true,
  "a state change emits regardless of cadence",
);
assert.equal(
  shouldEmitCompact({ ...gate, now: 160 }),
  true,
  "cadence expiry emits",
);
assert.equal(
  shouldEmitCompact({ ...gate, renderStatus: 0 }),
  true,
  "the final caught-up render always emits",
);

// --- registration messages -------------------------------------------------

assert.equal(
  registrationPendingLine("abc1234", 0, { compact: true, warned: false }),
  "registration status=pending commit=abc1234 elapsed=0s poll=30s",
);
// Compact mode says it once and then stays silent until something changes.
assert.equal(
  registrationPendingLine("abc1234", 30, { compact: true, warned: false }),
  null,
);
assert.match(
  registrationPendingLine("abc1234", 30, { compact: false, warned: false }),
  /not registered yet \(30s elapsed\); checking again in 30s/,
);
assert.match(
  registrationPendingLine("abc1234", 210, { compact: false, warned: true }),
  /webhook suspect — see warning above/,
);

// The "within N minutes" arithmetic is the whole reason the timeout override is
// refused rather than coerced, so assert the rendered line, not just the
// refusal. Math.trunc, and a value that is not a whole number of minutes.
const timedOutLines = registrationTimeoutLines("abc1234", 600);
assert.match(timedOutLines[0], /did not register within 10 minutes/);
assert.match(
  registrationTimeoutLines("abc1234", 90)[0],
  /did not register within 1 minutes/,
);
assert.ok(
  timedOutLines.some((l) => l.includes("3 live deployments")),
  "the timeout block must still name the deployment-slot cause first",
);
assert.ok(
  timedOutLines.some((line) => line.includes("deployment cleanup inventory")),
  "the timeout block must route deletion through the cleanup workflow",
);
assert.ok(
  timedOutLines.some((l) => l.includes("envio.dev/app/mento-protocol")),
);

const warning = slowRegistrationWarning("abc1234", 210, 600);
assert.equal(warning[0], "", "the warning opens with a blank line");
assert.equal(warning.at(-1), "", "and closes with one");
assert.match(warning[1], /still unregistered after 210s/);
assert.ok(
  warning.some((line) => line.includes("deployment cleanup inventory")),
  "the capacity warning must route deletion through the cleanup workflow",
);
assert.match(warning.at(-2), /Will keep polling until 600s then give up/);

// --- end to end, with the CLI stubbed --------------------------------------

// The pure functions above are the logic, but the orchestration around them —
// exit-code mapping, which stream each line lands on, and the spawn-failure
// branch — is exactly what a port breaks. Drive the real command with a stub
// `pnpm` first on PATH so those paths have a standing regression net rather
// than a one-off harness.

const stubDir = mkdtempSync(join(tmpdir(), "status-stub-"));
const listJson = join(stubDir, "list.json");
const statusJson = join(stubDir, "status.json");
writeFileSync(
  listJson,
  JSON.stringify({
    data: {
      deployments: [
        { commit_hash: "abc1234", created_time: "2026-08-19T00:00:00.000Z" },
      ],
    },
  }),
);
writeFileSync(
  join(stubDir, "pnpm"),
  `#!/usr/bin/env bash
if [[ "\${1:-}" == "exec" && "\${2:-}" == "envio-cloud" ]]; then
  [[ -n "\${STUB_WARN:-}" ]] && echo "$STUB_WARN" >&2
  [[ "\${3:-}" == "indexer" ]] && { cat "${listJson}"; exit 0; }
  # STUB_FAIL makes only the status call fail, so resolution still succeeds and
  # the failure lands inside the watch loop with a distinctive code.
  [[ "\${3:-}" == "deployment" && -n "\${STUB_FAIL:-}" ]] && exit 42
  [[ "\${3:-}" == "deployment" ]] && { cat "${statusJson}"; exit 0; }
fi
exit 97
`,
);
chmodSync(join(stubDir, "pnpm"), 0o755);

const COMMAND = fileURLToPath(
  new URL("./deploy-indexer-status.mjs", import.meta.url),
);

function runCommand(argv, { status, env } = {}) {
  writeFileSync(statusJson, JSON.stringify(status ?? { data: [] }));
  return spawnSync(process.execPath, [COMMAND, ...argv], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, ...env },
  });
}

const syncingStatus = {
  data: [
    {
      chain_id: 42220,
      start_block: 0,
      block_height: 1000,
      latest_processed_block: 500,
      num_events_processed: 3,
      timestamp_caught_up_to_head_or_endblock: null,
    },
  ],
};
const caughtUpStatus = {
  data: [
    {
      chain_id: 42220,
      start_block: 0,
      block_height: 1000,
      latest_processed_block: 1000,
      num_events_processed: 9,
      timestamp_caught_up_to_head_or_endblock: "2026-08-19T04:05:06.789Z",
    },
  ],
};

// A one-shot run reports "syncing" in its output and still exits 0: the
// sentinel collapses here, and only here.
const oneShotSyncing = runCommand(["abc1234"], { status: syncingStatus });
assert.equal(oneShotSyncing.status, 0);
assert.match(oneShotSyncing.stdout, /📊 Deployment: abc1234/);
assert.match(oneShotSyncing.stdout, /Status: syncing/);

const oneShotDone = runCommand(["abc1234"], { status: caughtUpStatus });
assert.equal(oneShotDone.status, 0);
assert.match(oneShotDone.stdout, /Status: caught up/);

// Watch keeps the sentinel's meaning: it returns only once caught up.
const watched = runCommand(["abc1234", "--watch"], { status: caughtUpStatus });
assert.equal(watched.status, 0);
assert.match(watched.stdout, /Status: caught up/);

const watchedCompact = runCommand(["abc1234", "--watch", "--compact"], {
  status: caughtUpStatus,
});
assert.equal(watchedCompact.status, 0);
assert.match(watchedCompact.stdout, /status=caught_up .*cadence=0s/);

// --json passes the CLI payload through untouched, with no decoration.
const jsonRun = runCommand(["abc1234", "--json"], { status: caughtUpStatus });
assert.equal(jsonRun.status, 0);
assert.deepEqual(JSON.parse(jsonRun.stdout), caughtUpStatus);
assert.doesNotMatch(jsonRun.stdout, /📊/);

// The argument refusal lands on STDOUT, and the flag refusal on STDERR.
const badArg = runCommand(["abc1234", "def5678"]);
assert.equal(badArg.status, 1);
assert.match(badArg.stdout, /❌ Unexpected argument: def5678/);
assert.equal(badArg.stderr, "");

const badFlag = runCommand(["abc1234", "--compact"]);
assert.equal(badFlag.status, 1);
assert.match(badFlag.stderr, /--compact requires --watch/);
assert.equal(badFlag.stdout, "");

// An unregistered commit fails with the registration hint, not a stack trace.
const missing = runCommand(["nope123"]);
assert.equal(missing.status, 1);
assert.match(missing.stderr, /not found for mento-protocol\/mento/);
assert.match(missing.stderr, /Re-run with --watch to wait for registration/);

// A warning the CLI prints on a SUCCESSFUL call must still reach the operator:
// the shell captured stdout only, so swallowing stderr would lose it.
const warned = runCommand(["abc1234"], {
  status: caughtUpStatus,
  env: { STUB_WARN: "warning: deployment nearing quota" },
});
assert.equal(warned.status, 0);
assert.match(warned.stderr, /deployment nearing quota/);

// A stale malformed timeout export must not break a run that never reads it.
const unreadTimeout = runCommand(["abc1234"], {
  status: caughtUpStatus,
  env: { ENVIO_REGISTRATION_TIMEOUT_SECONDS: "10m" },
});
assert.equal(unreadTimeout.status, 0);

// ...but the watch path, which does read it, refuses.
const readTimeout = runCommand(["abc1234", "--watch"], {
  status: caughtUpStatus,
  env: { ENVIO_REGISTRATION_TIMEOUT_SECONDS: "10m" },
});
assert.equal(readTimeout.status, 1);
assert.match(
  readTimeout.stderr,
  /ENVIO_REGISTRATION_TIMEOUT_SECONDS must be an integer/,
);

// A CLI that cannot launch must not be reported as a registration timeout: 1 is
// the timeout sentinel, so a failed launch carries 127 and says what happened.
// PATH is emptied so `pnpm` resolves to nothing.
const noCli = spawnSync(process.execPath, [COMMAND, "abc1234"], {
  encoding: "utf8",
  env: { ...process.env, PATH: stubDir.replace(stubDir, "/nonexistent") },
});
assert.equal(noCli.status, SPAWN_FAILED);
assert.match(noCli.stderr, /envio-cloud did not complete/);

// Under --watch the same failure must reach the "failed to resolve" branch, not
// the "did not register within 10 minutes" one.
const noCliWatch = spawnSync(
  process.execPath,
  [COMMAND, "abc1234", "--watch"],
  {
    encoding: "utf8",
    env: { ...process.env, PATH: "/nonexistent" },
  },
);
assert.equal(noCliWatch.status, 1);
assert.match(noCliWatch.stderr, /Failed to resolve deployment abc1234/);
assert.doesNotMatch(noCliWatch.stderr, /did not register within/);

// A CLI failure under --watch passes the child's real exit code through instead
// of flattening it to 1, which in this module means "did not register".
const watchCliFails = spawnSync(
  process.execPath,
  [COMMAND, "abc1234", "--watch"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      STUB_FAIL: "1",
    },
  },
);
assert.notEqual(watchCliFails.status, 0);
assert.notEqual(
  watchCliFails.status,
  1,
  "a CLI failure must not borrow the registration-timeout code",
);

// The capture ceiling is far above any real payload, and well above spawnSync's
// 1 MiB default — the shell's `$(...)` had no limit, so a payload that merely
// grew must not start failing.
assert.ok(MAX_CAPTURE_BYTES >= 64 * 1024 * 1024);

// A null status is always explained; a real exit code is left alone.
assert.match(
  spawnFailureLine({ status: null, error: new Error("spawn ENOENT") }, "thing"),
  /thing did not complete: spawn ENOENT/,
);
assert.equal(spawnFailureLine({ status: 1 }, "thing"), null);
assert.equal(spawnFailureLine({ status: 0 }, "thing"), null);

rmSync(stubDir, { recursive: true, force: true });

console.log("deploy-indexer-status tests passed.");
