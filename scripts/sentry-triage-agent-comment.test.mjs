#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_COMMENT_MARKER,
  assertBodyPostable,
  buildChildEnv,
  collectSecretValues,
  decorateBody,
  ISSUE_ENV_VAR,
  MIN_SECRET_LENGTH,
  parseArgs,
  postAgentComment,
  resolveTarget,
  TARGET_FILE_RELATIVE,
  targetFilePath,
  VERDICT_MARKER,
} from "./sentry-triage-agent-comment.mjs";

const RUNNER_TEMP_FOR_TESTS = "/runner/_temp";
const SENTRY_TOKEN = "sntrys_deadbeefdeadbeefdeadbeef";
const GH_TOKEN = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";
const OAUTH_TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

const VERDICT_BODY = [
  VERDICT_MARKER,
  "",
  "```yaml",
  "verdict: upstream-transient",
  "confidence: high",
  "```",
  "",
  "Third-party outage; nothing to fix here.",
].join("\n");

function baseEnv(overrides = {}) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/runner",
    RUNNER_TEMP: RUNNER_TEMP_FOR_TESTS,
    GITHUB_REPOSITORY: "mento-protocol/monitoring-monorepo",
    [ISSUE_ENV_VAR]: "123",
    GH_TOKEN,
    SENTRY_TRIAGE_TOKEN: SENTRY_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    ...overrides,
  };
}

/** A pinned target file as the trusted workflow step leaves it: read-only. */
function pin({
  repo = "mento-protocol/monitoring-monorepo",
  issue = "123",
} = {}) {
  return () => ({
    content: JSON.stringify({ repo, issue }),
    mode: 0o100444,
  });
}

/** Drive the whole flow with the gh call — argv, env and stdin — captured. */
async function post({
  argv = ["--body", VERDICT_BODY],
  env = baseEnv(),
  readPinnedTarget = pin(),
} = {}) {
  const calls = [];
  const result = await postAgentComment({
    argv,
    env,
    readPinnedTarget,
    runGh: (args, childEnv, stdin) => {
      calls.push({ args, childEnv, stdin });
      return Promise.resolve(
        "https://github.com/o/r/issues/123#issuecomment-1\n",
      );
    },
  });
  return { result, calls };
}

async function refusal(options) {
  let thrown = null;
  const calls = [];
  try {
    await postAgentComment({
      argv: options.argv ?? ["--body", VERDICT_BODY],
      env: options.env ?? baseEnv(),
      readPinnedTarget: options.readPinnedTarget ?? pin(),
      runGh: (args) => {
        calls.push(args);
        return Promise.resolve("");
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "expected the wrapper to refuse");
  assert.deepEqual(calls, [], "a refused post must never reach gh");
  return thrown;
}

// ── the write target comes from the trusted pinned file ──────────────────────

test("the target is read from the pinned file, not from argv", async () => {
  const { calls } = await post();
  assert.deepEqual(calls[0].args, [
    "issue",
    "comment",
    "123",
    "--repo",
    "mento-protocol/monitoring-monorepo",
    "--body-file",
    "-",
  ]);
});

test("the pinned file lives under RUNNER_TEMP at a fixed relative path", () => {
  assert.equal(
    targetFilePath(baseEnv()),
    `/runner/_temp/${TARGET_FILE_RELATIVE}`,
  );
  assert.throws(
    () => targetFilePath(baseEnv({ RUNNER_TEMP: "" })),
    /RUNNER_TEMP/,
  );
});

test("REGRESSION #1288: a shell-mutated env var cannot retarget the write", async () => {
  // `--body "…$((SENTRY_TRIAGE_COMMENT_ISSUE=1234))…"` is expanded by the
  // AGENT'S shell, so node starts with the attacker's number already in
  // process.env. Verified against bash: the child sees 1234. The pinned file
  // is what decides, and the disagreement is what gets reported.
  const err = await refusal({
    env: baseEnv({ [ISSUE_ENV_VAR]: "1234" }),
    readPinnedTarget: pin({ issue: "123" }),
  });
  assert.match(err.message, /write-target mismatch/);
  assert.match(err.message, /pinned file says 123/);
  assert.match(err.message, /says 1234/);
});

test("a mutated GITHUB_REPOSITORY cannot retarget the write either", async () => {
  const err = await refusal({
    env: baseEnv({ GITHUB_REPOSITORY: "attacker/repo" }),
  });
  assert.match(err.message, /write-target mismatch/);
  assert.match(err.message, /mento-protocol\/monitoring-monorepo/);
});

test("a WRITABLE pin is refused — a pin that can be rewritten is not a pin", async () => {
  for (const mode of [0o100644, 0o100666, 0o100464, 0o100446]) {
    const err = await refusal({
      readPinnedTarget: () => ({
        content: JSON.stringify({
          repo: "mento-protocol/monitoring-monorepo",
          issue: "123",
        }),
        mode,
      }),
    });
    assert.match(err.message, /is writable/, `mode ${mode.toString(8)}`);
  }
});

test("a missing, unparsable or malformed pin refuses", async () => {
  const missing = await refusal({
    readPinnedTarget: () => {
      throw new Error("ENOENT: no such file or directory");
    },
  });
  assert.match(missing.message, /cannot read the pinned write target/);

  const garbage = await refusal({
    readPinnedTarget: () => ({ content: "not json", mode: 0o100444 }),
  });
  assert.match(garbage.message, /not valid JSON/);

  for (const issue of ["", "12a", " ", "-1", "1_2"]) {
    const err = await refusal({
      readPinnedTarget: () => ({
        content: JSON.stringify({
          repo: "mento-protocol/monitoring-monorepo",
          issue,
        }),
        mode: 0o100444,
      }),
    });
    assert.match(err.message, /no integer issue/, JSON.stringify(issue));
  }

  const badRepo = await refusal({
    readPinnedTarget: () => ({
      content: JSON.stringify({ repo: "not-a-repo", issue: "123" }),
      mode: 0o100444,
    }),
  });
  assert.match(badRepo.message, /no owner\/repo/);
});

test("the wrapper hands gh no filesystem path, so none can be swapped", async () => {
  // The body-file argument is literally "-" (stdin). The pin is the only path
  // this script touches at all, and it only ever reads it.
  const { calls } = await post();
  const bodyFileValue = calls[0].args[calls[0].args.indexOf("--body-file") + 1];
  assert.equal(bodyFileValue, "-");
  assert.ok(
    !calls[0].args.some((arg) => arg.startsWith("/")),
    "no absolute path may appear in gh's argv",
  );
  assert.ok(
    !calls[0].args.some((arg) => arg.includes(RUNNER_TEMP_FOR_TESTS)),
    "nothing under RUNNER_TEMP may be handed to gh",
  );
});

test("digit-extension is closed by construction: the body cannot retarget", async () => {
  const body = `${VERDICT_BODY}\n\nSee also 1234 and 12345.`;
  const { calls } = await post({ argv: ["--body", body] });
  assert.equal(calls[0].args[2], "123");
});

test("an issue number passed as an argument is refused, not honoured", async () => {
  const err = await refusal({ argv: ["1234", "--body", VERDICT_BODY] });
  assert.match(err.message, /unexpected argument '1234'/);
});

test("--issue is not a flag this script understands", async () => {
  const err = await refusal({
    argv: ["--issue", "1234", "--body", VERDICT_BODY],
  });
  assert.match(err.message, /unexpected argument '--issue'/);
});

test("a missing RUNNER_TEMP refuses", () => {
  assert.throws(
    () => resolveTarget(baseEnv({ RUNNER_TEMP: "" }), pin()),
    /RUNNER_TEMP/,
  );
});

// ── argument parsing fails closed ────────────────────────────────────────────

test("--body is required, non-empty, and single", () => {
  assert.throws(() => parseArgs([]), /--body is required/);
  assert.throws(() => parseArgs(["--body"]), /--body needs a value/);
  assert.throws(() => parseArgs(["--body", "   "]), /must not be empty/);
  assert.throws(
    () => parseArgs(["--body", "a", "--body", "b"]),
    /more than once/,
  );
  assert.deepEqual(parseArgs(["--body", "x"]), { body: "x" });
});

// ── credential hygiene guard ─────────────────────────────────────────────────
//
// These cover ACCIDENTAL inclusion — prose that reproduces a credential because
// the agent quoted an environment value, a config dump, or a failed command's
// output. They are NOT evidence of a containment control and must not be read
// as one: the agent writes the shell command, so the shell can splice or
// substitute the value before this script ever receives argv. The last test in
// this block pins that limit. Closing it means getting the credential out of
// the agent's process env, which is outside this script.

test("a body that accidentally reproduces the Sentry token is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\nnote: ${SENTRY_TOKEN}`],
  });
  assert.match(err.message, /SENTRY_TRIAGE_TOKEN/);
  assert.ok(
    !err.message.includes(SENTRY_TOKEN),
    "the refusal must name the variable, never echo the value",
  );
});

test("a body that accidentally reproduces GH_TOKEN is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\n${GH_TOKEN}`],
  });
  assert.match(err.message, /GH_TOKEN/);
  assert.ok(!err.message.includes(GH_TOKEN));
});

test("a body that accidentally reproduces the Claude OAuth token is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\n${OAUTH_TOKEN}`],
  });
  assert.match(err.message, /CLAUDE_CODE_OAUTH_TOKEN/);
});

test("the verbatim value only has to appear somewhere in the body", () => {
  const secrets = collectSecretValues(baseEnv());
  assert.throws(
    () => assertBodyPostable(`${VERDICT_MARKER} ${SENTRY_TOKEN} tail`, secrets),
    /SENTRY_TRIAGE_TOKEN/,
  );
});

test("DOCUMENTED LIMIT: the guard is not containment — a shell-transformed token passes", () => {
  const secrets = collectSecretValues(baseEnv());
  // What `--body "…${SENTRY_TRIAGE_TOKEN:0:4}x${SENTRY_TRIAGE_TOKEN:4}"` hands
  // this script: the whole token with one removable character spliced in. Bash
  // did that expansion; argv is all we ever see. Splitting the value across two
  // lines defeats the scan just as easily. Asserted, not fixed — exact-value
  // scanning is the wrong layer when the adversary controls the shell.
  const spliced = `${SENTRY_TOKEN.slice(0, 4)}x${SENTRY_TOKEN.slice(4)}`;
  const split = `${SENTRY_TOKEN.slice(0, 10)}\n${SENTRY_TOKEN.slice(10)}`;
  for (const evaded of [spliced, split]) {
    assert.doesNotThrow(
      () => assertBodyPostable(`${VERDICT_MARKER}\n\n${evaded}`, secrets),
      "the guard is documented as hygiene-only; do not assert containment here",
    );
  }
});

test("short env values are not treated as secrets", () => {
  const short = "a".repeat(MIN_SECRET_LENGTH - 1);
  const secrets = collectSecretValues(baseEnv({ GITHUB_TOKEN: short }));
  assert.ok(!secrets.some((secret) => secret.name === "GITHUB_TOKEN"));
  assert.doesNotThrow(() =>
    assertBodyPostable(`${VERDICT_MARKER}\n${short}`, secrets),
  );
});

// ── authorship marker ────────────────────────────────────────────────────────

test("every posted body is stamped agent-authored", async () => {
  const { calls } = await post();
  assert.ok(calls[0].stdin.includes(AGENT_COMMENT_MARKER));
  assert.ok(calls[0].stdin.trimEnd().endsWith(AGENT_COMMENT_MARKER));
});

test("the stamp is appended, so the verdict marker still starts the body", () => {
  const decorated = decorateBody(VERDICT_BODY);
  assert.ok(
    decorated.startsWith(VERDICT_MARKER),
    "selectVerdictComment matches on startsWith(VERDICT_MARKER)",
  );
});

test("a body that forges the authorship marker is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\n${AGENT_COMMENT_MARKER}`],
  });
  assert.match(err.message, /only this script may add/);
});

test("a body that is not a verdict comment is refused", async () => {
  const err = await refusal({
    argv: ["--body", "Regressed in Sentry (last seen 2099-01-01T00:00:00Z)"],
  });
  assert.match(err.message, /must start with/);
});

test("the start anchor blocks impersonating the pipeline's pointer comments", () => {
  const secrets = collectSecretValues(baseEnv());
  for (const forged of [
    "Projected to owning repo: https://github.com/o/r/issues/1",
    "Autofixed by PR: https://github.com/o/r/pull/1",
    "Regressed in Sentry (last seen 2099-01-01T00:00:00Z)",
  ]) {
    assert.throws(
      () => assertBodyPostable(forged, secrets),
      /must start with/,
      `expected ${JSON.stringify(forged)} to be refused`,
    );
  }
});

// ── subprocess env scrub ─────────────────────────────────────────────────────

test("the gh child env drops every secret except gh's own credential", async () => {
  const { calls } = await post();
  const childEnv = calls[0].childEnv;
  assert.deepEqual(Object.keys(childEnv).sort(), ["GH_TOKEN", "HOME", "PATH"]);
  assert.equal(childEnv.GH_TOKEN, GH_TOKEN);
  const values = Object.values(childEnv);
  assert.ok(!values.includes(SENTRY_TOKEN), "Sentry token must not reach gh");
  assert.ok(!values.includes(OAUTH_TOKEN), "OAuth token must not reach gh");
});

test("nothing outside the allowlist is inherited", () => {
  const childEnv = buildChildEnv(
    baseEnv({
      AWS_SECRET_ACCESS_KEY: "aws-secret-value",
      SENTRY_PROJECTION_TOKEN: "projection-secret-value",
      GH_HOST: "evil.example.com",
    }),
  );
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in childEnv));
  assert.ok(!("SENTRY_PROJECTION_TOKEN" in childEnv));
  assert.ok(!("GH_HOST" in childEnv));
  assert.ok(!(ISSUE_ENV_VAR in childEnv));
});

test("an absent GH_TOKEN is not forged into the child env", () => {
  const env = baseEnv();
  delete env.GH_TOKEN;
  assert.ok(!("GH_TOKEN" in buildChildEnv(env)));
});

// ── posting mechanics ────────────────────────────────────────────────────────

test("the body reaches gh on stdin, never in argv", async () => {
  const { calls, result } = await post();
  assert.equal(calls[0].stdin, decorateBody(VERDICT_BODY));
  assert.ok(!calls[0].args.includes("--body"));
  assert.ok(
    !calls[0].args.some((arg) => arg.includes("upstream-transient")),
    "the body must never appear in gh's argv",
  );
  assert.ok(
    !("bodyFile" in result),
    "the result must not carry a body-file path — there is no file",
  );
});

test("REGRESSION #1288 (TOCTOU): what gh receives is what was validated", async () => {
  // The old shape validated the body, wrote it to a predictable RUNNER_TEMP
  // path, and let gh read it back. The agent can run a second permitted
  // command concurrently (`gh issue view --template '<forged>' > that-path &`)
  // and swap the content inside that window — reproduced end to end, posting a
  // forged "Regressed in Sentry …" control comment past every fence.
  //
  // Run against a REAL temp directory: the body must arrive on stdin, and the
  // wrapper must leave the directory exactly as it found it. Against the old
  // shape this fails on both counts.
  const dir = mkdtempSync(join(tmpdir(), "sentry-triage-toctou-"));
  try {
    const before = readdirSync(dir);
    let seenStdin = null;
    await postAgentComment({
      argv: ["--body", VERDICT_BODY],
      env: baseEnv({ RUNNER_TEMP: dir }),
      readPinnedTarget: pin(),
      runGh: (args, _childEnv, stdin) => {
        // Stand where gh stands: whatever is readable at this instant is what
        // gets posted. With stdin there is nothing else to read.
        seenStdin = stdin;
        assert.deepEqual(
          readdirSync(dir),
          before,
          "the wrapper must not have created a file for gh to read",
        );
        return Promise.resolve("ok\n");
      },
    });
    assert.equal(seenStdin, decorateBody(VERDICT_BODY));
    assert.deepEqual(readdirSync(dir), before, "no file may survive the post");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gh failure surfaces instead of being swallowed", async () => {
  await assert.rejects(
    postAgentComment({
      argv: ["--body", VERDICT_BODY],
      env: baseEnv(),
      readPinnedTarget: pin(),
      runGh: () => Promise.reject(new Error("gh exited 1: HTTP 403")),
      writeFile: () => Promise.resolve(),
    }),
    /HTTP 403/,
  );
});

// ── the executed closure must leave the agent-writable checkout ──────────────
//
// The agent can write the checkout: Claude Code matches `Bash(cmd:*)` against a
// command carrying a redirection (CHANGELOG v1.0.123), and `gh issue view
// --template` renders arbitrary text, so `gh issue view <n> --template '<js>' >
// scripts/sentry-triage-agent-comment.mjs` is inside its read-only grants. The
// workflow therefore runs a read-only COPY from $RUNNER_TEMP. If the wrapper
// grows an import the copy step does not carry, the attack just moves one file
// over — so the closure is recomputed here from the source, not trusted to a
// comment.

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = readFileSync(
  join(SCRIPTS_DIR, "..", ".github", "workflows", "sentry-triage-agent.yml"),
  "utf8",
);

/** Transitive closure of relative (in-repo) imports, entry point included. */
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(SCRIPTS_DIR, file), "utf8");
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["'](\.\/[^"']+)["']/g,
    )) {
      queue.push(match[1].replace(/^\.\//, ""));
    }
  }
  return [...seen].sort();
}

test("the wrapper's runtime closure is exactly what the workflow stages", () => {
  const closure = importClosure("sentry-triage-agent-comment.mjs");
  assert.deepEqual(closure, [
    "sentry-triage-agent-comment.mjs",
    "sentry-triage-project-core.mjs",
  ]);
  // Every file in the closure must appear in the staging step's copy list.
  const stagingBlock = WORKFLOW.slice(
    WORKFLOW.indexOf("Stage immutable agent tools"),
    WORKFLOW.indexOf("Render triage prompt"),
  );
  assert.ok(stagingBlock.length > 0, "staging step not found in the workflow");
  for (const file of closure) {
    assert.ok(
      stagingBlock.includes(file),
      `${file} is in the wrapper's runtime closure but the staging step does not copy it`,
    );
  }
});

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

test("the agent job ENDS with the agent — nothing runs after it", () => {
  // The property that makes $GITHUB_ENV injection inert. The agent can append
  // `BASH_ENV=<payload it wrote>` to $GITHUB_ENV; GitHub exports that to every
  // later step in the SAME job, and the step's bash sources the payload before
  // running its own command — which staging immutable copies does not prevent,
  // because the payload runs first. So there must be no later step.
  const steps = [
    ...triageJobBlock().matchAll(/^ {6}- (?:name|uses):\s*(.+)$/gm),
  ].map((m) => m[1].trim());
  assert.ok(steps.length > 0, "no steps parsed out of the triage job");
  assert.match(
    steps.at(-1),
    /^anthropics\/claude-code-action@/,
    `the agent must be the LAST step of its job; found "${steps.at(-1)}" after it`,
  );
});

test("no credential-bearing work follows the agent in its job", () => {
  const job = triageJobBlock();
  const afterAgent = job.slice(job.indexOf("anthropics/claude-code-action@"));
  for (const forbidden of [
    /- name: Apply verdict label/,
    /- name: Close queue stub/,
    /gh issue edit/,
    /gh issue close/,
    /node scripts\//,
  ]) {
    assert.ok(
      !forbidden.test(afterAgent),
      `credential-bearing work follows the agent: ${forbidden}`,
    );
  }
});

test("the trusted follow-up lives in its own job, on its own runner", () => {
  const job = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  verdict:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  assert.match(job, /needs: \[select, triage\]/);
  assert.match(job, /Apply verdict label \(deterministic\)/);
  assert.match(job, /Close queue stub \(deterministic\)/);
  assert.match(job, /persist-credentials: false/);
  // Narrowest permissions for the work, not a copy of the agent job's, and no
  // secret-bearing environment: this job holds only github.token.
  assert.match(job, /permissions:\n\s+contents: read\n\s+issues: write/);
  assert.ok(
    !/environment:/.test(job),
    "the verdict job holds no secret and must not claim a secret environment",
  );
  // Its checkout is pristine and the agent never touched this runner, so plain
  // scripts/ is correct HERE — and only here.
  assert.match(job, /node scripts\/sentry-triage-project\.mjs/);
});

test("the verdict edit sheds the other verdict labels and proves it landed", () => {
  const job = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  verdict:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  // The shed list comes from the SAME --parse-only output as the label, so the
  // workflow never carries a second literal copy of the verdict namespace.
  assert.match(job, /shed=\$\(jq -r '\.shed' "\$\{parse_file\}"\)/);
  assert.match(job, /--remove-label "sentry:needs-triage,\$\{shed\}"/);
  // Deleting the shed and going back to the bare removal must fail here.
  assert.ok(
    !/--remove-label ['"]sentry:needs-triage['"]/.test(job),
    "the verdict edit removes only sentry:needs-triage; stale verdict labels would survive it",
  );
  // Post-condition: the stub is re-read and >1 surviving verdict label fails
  // this matrix job rather than reaching the close/project/digest legs.
  assert.match(job, /select\(startswith\("sentry:verdict-"\)\)/);
  assert.match(job, /if \[ "\$\{survivor_count\}" -gt 1 \]; then/);
});

/**
 * The verdict label step from the edit that takes `sentry:needs-triage` off to
 * the end of the step — the window where the stub is invisible to the selector
 * and every exit therefore owes it a re-queue.
 */
function verdictPostConditionBlock() {
  const job = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  verdict:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  const start = job.indexOf('--remove-label "sentry:needs-triage,${shed}"');
  const end = job.indexOf("- name: Close queue stub");
  assert.ok(
    start > 0 && end > start,
    "the verdict label step's post-condition block was not found",
  );
  return job.slice(start, end);
}

test("a failed verdict post-condition re-queues the stub instead of stranding it", () => {
  const block = verdictPostConditionBlock();
  const lines = block.split("\n");

  // The compensation: the close step's shape (restore sentry:needs-triage,
  // shed the verdict label + any stale sentry:projected), widened to the whole
  // verdict namespace because this is the one branch where a stub can be
  // wearing more than one verdict label — and a re-queued stub carries none.
  const open = lines.findIndex(
    (line) => line.trim() === "requeue_for_retry() {",
  );
  assert.ok(open >= 0, "the verdict post-condition has no re-queue helper");
  const close = lines.findIndex((line, i) => i > open && line.trim() === "}");
  const helper = lines.slice(open, close).join("\n");
  assert.match(helper, /gh issue edit "\$\{QUEUE_ISSUE_NUMBER\}"/);
  assert.match(
    helper,
    /--remove-label "\$\{label\},\$\{shed\},sentry:projected"/,
  );
  assert.match(helper, /--add-label "sentry:needs-triage"/);

  // Fail CLOSED on the re-read too: an unverifiable stub is re-queued, never
  // waved through to the close/project/digest legs.
  assert.match(block, /if ! gh issue view "\$\{QUEUE_ISSUE_NUMBER\}"/);

  // The property the whole block exists for: no exit leaves the stub open,
  // verdict-labeled and off sentry:needs-triage, which nothing downstream
  // re-queues — the close step never runs, the project job skips it, and the
  // scheduled selector requires sentry:needs-triage. Deleting the call from
  // any failure branch fails here.
  const meaningful = lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const exits = meaningful.filter((line) => line === "exit 1");
  assert.ok(
    exits.length >= 2,
    `expected the read-failure and surviving-label exits, found ${exits.length}`,
  );
  meaningful.forEach((line, i) => {
    if (line !== "exit 1") return;
    assert.equal(
      meaningful[i - 1],
      "requeue_for_retry",
      "an exit from the verdict post-condition must restore sentry:needs-triage first, or the open stub is stranded with no retry path",
    );
  });
});

/** The select job's block, from its key to the triage job's. */
function selectJobBlock() {
  const start = WORKFLOW.indexOf("\n  select:");
  const end = WORKFLOW.indexOf("\n  triage:");
  assert.ok(start > 0 && end > start, "select/triage job boundaries not found");
  return WORKFLOW.slice(start, end);
}

test("the round binding is recorded BEFORE the agent runs (#1717)", () => {
  // Only the select job can record it: it is trusted AND it runs before the
  // agent, so what it reads is what the round started from. Recorded anywhere
  // later it would see the round's own comment and prove nothing.
  const select = selectJobBlock();
  assert.match(select, /--prior-verdicts/);
  assert.match(select, /priorVerdicts: \$\{\{ steps\.prior-verdicts\.outputs/);
  assert.match(select, /node scripts\/sentry-triage-project\.mjs/);
  // It needs its own pristine checkout to run that script, and no agent runs
  // in this job.
  assert.match(select, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(select, /persist-credentials: false/);
  // No other job may recompute it: a second recorder would be free to read the
  // stub after the agent posted, which defeats the whole binding.
  const elsewhere = WORKFLOW.replace(select, "");
  assert.ok(
    !/--prior-verdicts\b/.test(elsewhere),
    "only the select job may record the prior verdict comment",
  );
});

test("the verdict step binds its resolution to the recorded round (#1717)", () => {
  const job = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  verdict:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  // The token travels through env + jq, never string-interpolated into the
  // command line, and its shape is checked against the parser's closed set.
  assert.match(
    job,
    /PRIOR_VERDICTS: \$\{\{ needs\.select\.outputs\.priorVerdicts \}\}/,
  );
  assert.match(job, /\^\(\[0-9\]\+\|none\|unknown\)\$/);
  assert.match(job, /--prior-verdict-comment "\$\{prior\}"/);
  // A missing record must resolve to `unknown` (which the parser refuses), not
  // to an empty string that would silently unbind the fence.
  assert.match(job, /'\.\[\$n\] \/\/ "unknown"'/);

  // The refusal has to land BEFORE the label edit takes sentry:needs-triage
  // off; after it, a refusal would strand the stub instead of re-queueing it.
  const parse = job.indexOf("--prior-verdict-comment");
  const edit = job.indexOf('--remove-label "sentry:needs-triage,${shed}"');
  assert.ok(
    parse > 0 && edit > parse,
    "the binding must be checked before the label edit",
  );
});

test("projection and digest wait for the verdict job", () => {
  assert.match(WORKFLOW, /project:\n\s+needs: \[select, triage, verdict\]/);
  assert.match(
    WORKFLOW,
    /digest:\n\s+needs: \[select, triage, verdict, project\]/,
  );
});

test("no executable grant or in-job node call points at the checkout", () => {
  const grant = /--allowedTools '([^']*)'/.exec(WORKFLOW);
  assert.ok(grant, "--allowedTools not found");
  const bashGrants = [...grant[1].matchAll(/Bash\(([^)]*)\)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(bashGrants, [
    "gh issue view:*",
    "gh issue list:*",
    "node ${{ runner.temp }}/sentry-triage-tools/sentry-triage-agent-comment.mjs:*",
  ]);
  for (const g of bashGrants) {
    assert.ok(
      !/(^|\s)node\s+scripts\//.test(g),
      `grant executes a checkout path: ${g}`,
    );
  }
  // And no step in the AGENT job runs node against the checkout. (The verdict
  // job does, correctly: its runner and checkout are pristine.)
  assert.ok(
    !/node scripts\//.test(triageJobBlock()),
    "the triage job still executes a script from the agent-writable checkout",
  );
});

test("the agent job's checkout does not persist the git credential", () => {
  const triageJob = WORKFLOW.slice(
    WORKFLOW.indexOf("\n  triage:"),
    WORKFLOW.indexOf("\n  project:"),
  );
  assert.match(triageJob, /persist-credentials: false/);
});
