#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";

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
  VERDICT_MARKER,
} from "./sentry-triage-agent-comment.mjs";

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
    RUNNER_TEMP: "/runner/_temp",
    GITHUB_REPOSITORY: "mento-protocol/monitoring-monorepo",
    [ISSUE_ENV_VAR]: "123",
    GH_TOKEN,
    SENTRY_TRIAGE_TOKEN: SENTRY_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    ...overrides,
  };
}

/** Drive the whole flow with the gh call and the file write captured. */
async function post({ argv = ["--body", VERDICT_BODY], env = baseEnv() } = {}) {
  const calls = [];
  const writes = [];
  const result = await postAgentComment({
    argv,
    env,
    runGh: (args, childEnv) => {
      calls.push({ args, childEnv });
      return Promise.resolve(
        "https://github.com/o/r/issues/123#issuecomment-1\n",
      );
    },
    writeFile: (path, contents) => {
      writes.push({ path, contents });
      return Promise.resolve();
    },
  });
  return { result, calls, writes };
}

async function refusal(options) {
  let thrown = null;
  const calls = [];
  const writes = [];
  try {
    await postAgentComment({
      argv: options.argv ?? ["--body", VERDICT_BODY],
      env: options.env ?? baseEnv(),
      runGh: (args) => {
        calls.push(args);
        return Promise.resolve("");
      },
      writeFile: (path, contents) => {
        writes.push({ path, contents });
        return Promise.resolve();
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "expected the wrapper to refuse");
  assert.deepEqual(calls, [], "a refused post must never reach gh");
  assert.deepEqual(writes, [], "a refused post must never write a body file");
  return thrown;
}

// ── write target comes from the environment, never from arguments ────────────

test("the issue number is read from the workflow env var", async () => {
  const { calls } = await post();
  assert.deepEqual(calls[0].args, [
    "issue",
    "comment",
    "123",
    "--repo",
    "mento-protocol/monitoring-monorepo",
    "--body-file",
    "/runner/_temp/sentry-triage-agent-comment-123.md",
  ]);
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

test("a non-integer or missing target env var refuses", () => {
  for (const issue of ["", "12a", " 123", "123 ", "-1", "1_2"]) {
    assert.throws(
      () => resolveTarget(baseEnv({ [ISSUE_ENV_VAR]: issue })),
      new RegExp(ISSUE_ENV_VAR),
      `expected ${JSON.stringify(issue)} to be refused`,
    );
  }
  const missing = baseEnv();
  delete missing[ISSUE_ENV_VAR];
  assert.throws(() => resolveTarget(missing), new RegExp(ISSUE_ENV_VAR));
});

test("a bad repo or missing RUNNER_TEMP refuses", () => {
  assert.throws(
    () => resolveTarget(baseEnv({ GITHUB_REPOSITORY: "not-a-repo" })),
    /GITHUB_REPOSITORY/,
  );
  assert.throws(
    () => resolveTarget(baseEnv({ RUNNER_TEMP: "" })),
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

// ── exfiltration refusal ─────────────────────────────────────────────────────

test("a body containing the Sentry token value is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\nnote: ${SENTRY_TOKEN}`],
  });
  assert.match(err.message, /SENTRY_TRIAGE_TOKEN/);
  assert.ok(
    !err.message.includes(SENTRY_TOKEN),
    "the refusal must name the variable, never echo the value",
  );
});

test("a body containing the GH_TOKEN value is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\n${GH_TOKEN}`],
  });
  assert.match(err.message, /GH_TOKEN/);
  assert.ok(!err.message.includes(GH_TOKEN));
});

test("a body containing the Claude OAuth token value is refused", async () => {
  const err = await refusal({
    argv: ["--body", `${VERDICT_BODY}\n\n${OAUTH_TOKEN}`],
  });
  assert.match(err.message, /CLAUDE_CODE_OAUTH_TOKEN/);
});

test("the token only has to appear somewhere in the body", () => {
  const secrets = collectSecretValues(baseEnv());
  assert.throws(
    () => assertBodyPostable(`${VERDICT_MARKER} ${SENTRY_TOKEN} tail`, secrets),
    /SENTRY_TRIAGE_TOKEN/,
  );
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
  const { writes } = await post();
  assert.ok(writes[0].contents.includes(AGENT_COMMENT_MARKER));
  assert.ok(writes[0].contents.trimEnd().endsWith(AGENT_COMMENT_MARKER));
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

test("the body is posted from a RUNNER_TEMP file, never in argv", async () => {
  const { calls, writes, result } = await post();
  assert.equal(
    writes[0].path,
    "/runner/_temp/sentry-triage-agent-comment-123.md",
  );
  assert.equal(writes[0].contents, decorateBody(VERDICT_BODY));
  assert.equal(result.bodyFile, writes[0].path);
  assert.ok(!calls[0].args.includes("--body"));
  assert.ok(
    !calls[0].args.some((arg) => arg.includes("upstream-transient")),
    "the body must never appear in gh's argv",
  );
});

test("a gh failure surfaces instead of being swallowed", async () => {
  await assert.rejects(
    postAgentComment({
      argv: ["--body", VERDICT_BODY],
      env: baseEnv(),
      runGh: () => Promise.reject(new Error("gh exited 1: HTTP 403")),
      writeFile: () => Promise.resolve(),
    }),
    /HTTP 403/,
  );
});
