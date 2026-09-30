import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProvider,
  verifyUnmanagedPolicy,
} from "./review-eval-v2-provider.mjs";

const subscription = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "max",
};
const request = {
  label: "review",
  prompt: "Review",
  model: "test",
  effort: "high",
  reviewer: true,
  allowedTools: ["Read", "Bash", "Agent"],
};
function setup(
  context,
  { statuses = [subscription], costs = [null], fail = false, env = {} } = {},
) {
  const out = mkdtempSync(path.join(tmpdir(), "v2-provider-test-"));
  context.after(() => rmSync(out, { recursive: true, force: true }));
  const authCalls = [];
  const modelCalls = [];
  const options = {
    out,
    repoRoot: out,
    version: "test",
    env,
    verifyPolicy: () => {},
    execAuth: (name, args, settings) => {
      authCalls.push({ name, args, settings });
      return JSON.stringify(
        statuses[Math.min(authCalls.length - 1, statuses.length - 1)],
      );
    },
    spawnProcess: (name, args, settings) => {
      modelCalls.push({ name, args, settings });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        if (fail) {
          child.emit("close", 1);
          return;
        }
        const cost = costs[Math.min(modelCalls.length - 1, costs.length - 1)];
        child.stdout.write(
          `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Final review" }] } })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "result", result: "Final review", is_error: false, duration_ms: 5, ...(cost === null ? {} : { total_cost_usd: cost }) })}\n`,
        );
        child.emit("close", 0);
      });
      return child;
    },
  };
  return {
    out,
    authCalls,
    modelCalls,
    options,
    invoke: (provider) => provider.invoke({ ...request, cwd: out }),
  };
}

test("subscription calls have no dollar stop, keep unknown usage, and retain tool restrictions", async (context) => {
  const s = setup(context, {
    costs: [1000, null],
    env: { PATH: "/usr/bin", GH_TOKEN: "never-forward" },
  });
  const provider = createProvider(s.options);
  await s.invoke(provider);
  const result = await s.invoke(provider);
  assert.equal(result.envelope.result, "Final review");
  assert.equal(result.envelope.total_cost_usd, null);
  assert.ok(result.stream.includes('"type":"assistant"'));
  assert.equal(s.modelCalls[0].args.includes("--max-budget-usd"), false);
  assert.equal(s.authCalls.length, 2, "verify current auth before every call");
  for (const [index, call] of s.modelCalls.entries()) {
    const args = call.args;
    assert.equal(args.includes("--max-budget-usd"), false);
    assert.equal(args[args.indexOf("--tools") + 1], "Read");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.ok(args.includes("--restricted"));
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    const auth = s.authCalls[index];
    assert.deepEqual(auth.args, [
      "--setting-sources",
      "",
      "auth",
      "status",
      "--json",
    ]);
    assert.deepEqual(auth.settings.env, call.settings.env);
    assert.equal(auth.settings.cwd, call.settings.cwd);
    assert.equal(call.settings.env.GH_TOKEN, undefined);
  }
  const ledger = JSON.parse(
    readFileSync(path.join(s.out, "spend.json"), "utf8"),
  );
  assert.equal(ledger.billing_mode, "subscription");
  assert.equal(ledger.limit_usd, null);
  assert.equal(ledger.calls[0].actual_usd, 1000);
  assert.equal(ledger.calls[1].actual_usd, null);
  assert.equal(ledger.calls[1].reserved_usd, null);
  assert.equal(ledger.calls[1].charged_usd, null);
  assert.equal(createProvider(s.options).ledger.calls.length, 2);
});

test("API, unknown, logged-out, and changing auth fail before model launch", async (context) => {
  for (const bad of [
    { ...subscription, authMethod: "api_key" },
    { ...subscription, apiProvider: "bedrock" },
    { ...subscription, subscriptionType: null },
    { ...subscription, loggedIn: false },
    {},
  ]) {
    const s = setup(context, { statuses: [bad] });
    await assert.rejects(
      s.invoke(createProvider(s.options)),
      /verified Claude subscription/,
    );
    assert.equal(s.modelCalls.length, 0);
    assert.equal(existsSync(path.join(s.out, "spend.json")), false);
  }
  const s = setup(context, {
    statuses: [subscription, { ...subscription, authMethod: "api_key" }],
  });
  const provider = createProvider(s.options);
  await s.invoke(provider);
  await assert.rejects(s.invoke(provider), /verified Claude subscription/);
  assert.equal(s.modelCalls.length, 1);
  assert.equal(provider.ledger.calls.length, 1);
});

test("billing and endpoint environment overrides are refused without disclosing their values", async (context) => {
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    const s = setup(context, { env: { [key]: "secret-sentinel" } });
    await assert.rejects(s.invoke(createProvider(s.options)), (error) => {
      assert.match(error.message, /subscription authentication override/);
      assert.equal(error.message.includes("secret-sentinel"), false);
      return true;
    });
    assert.equal(s.authCalls.length, 0);
    assert.equal(s.modelCalls.length, 0);
  }
});

test("auth command failures and malformed output cannot start a model call", async (context) => {
  const s = setup(context);
  for (const execAuth of [
    () => {
      throw new Error("secret-sentinel");
    },
    () => "not json",
  ]) {
    await assert.rejects(
      s.invoke(createProvider({ ...s.options, execAuth })),
      (error) => {
        assert.match(error.message, /cannot verify Claude subscription/);
        assert.equal(error.message.includes("secret-sentinel"), false);
        return true;
      },
    );
  }
  assert.equal(s.modelCalls.length, 0);
});

test("legacy dollar ledgers are rejected without rewriting evidence", (context) => {
  const s = setup(context);
  const file = path.join(s.out, "spend.json");
  const old = '{"limit_usd":60,"calls":[]}\n';
  writeFileSync(file, old);
  assert.throws(() => createProvider(s.options), /legacy dollar-budget ledger/);
  assert.equal(readFileSync(file, "utf8"), old);
});

test("failed subscription calls retain incomplete evidence and unknown usage", async (context) => {
  const s = setup(context, { fail: true });
  const provider = createProvider(s.options);
  await assert.rejects(s.invoke(provider), /provider exited 1/);
  assert.equal(provider.ledger.calls[0].state, "failed");
  assert.equal(provider.ledger.calls[0].actual_usd, null);
  assert.equal(provider.ledger.calls[0].charged_usd, null);
  assert.equal(existsSync(path.join(s.out, "calls/0000.json")), true);
});

test("managed policy redirection and cached policy cannot pass subscription verification", async (context) => {
  for (const key of [
    "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
    "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
    "CLAUDE_CODE_MOCK_REMOTE_SETTINGS",
    "CLAUDE_CODE_BRIDGE_CHILD_MACHINE_SETTINGS",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  ]) {
    const s = setup(context, { env: { [key]: "private-policy-selector" } });
    await assert.rejects(
      s.invoke(createProvider(s.options)),
      /subscription authentication override/,
    );
    assert.equal(s.authCalls.length, 0);
    assert.equal(s.modelCalls.length, 0);
  }
  const s = setup(context);
  s.options.env = { CLAUDE_CONFIG_DIR: s.out };
  s.options.verifyPolicy = ({ env }) =>
    verifyUnmanagedPolicy({
      env,
      platform: "linux",
      stat: () => {
        const error = new Error("absent");
        error.code = "ENOENT";
        throw error;
      },
    });
  writeFileSync(
    path.join(s.out, "remote-settings.json"),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: "private-policy-token" } }),
  );
  await assert.rejects(s.invoke(createProvider(s.options)), /managed policy/);
  assert.equal(s.authCalls.length, 0);
  assert.equal(s.modelCalls.length, 0);
  assert.equal(existsSync(path.join(s.out, "spend.json")), false);
});

test("managed policy uncertainty fails closed across file and macOS preference sources", () => {
  const absent = () => {
    const error = new Error("absent");
    error.code = "ENOENT";
    throw error;
  };
  const base = { env: {}, platform: "linux", stat: absent, readDir: () => [] };
  assert.doesNotThrow(() => verifyUnmanagedPolicy(base));
  for (const source of [
    "/etc/claude-code/managed-settings.json",
    "/Library/Application Support/ClaudeCode/managed-settings.d",
  ]) {
    assert.throws(
      () =>
        verifyUnmanagedPolicy({
          ...base,
          stat: (file) => (file === source ? {} : absent()),
        }),
      /managed policy/,
    );
  }
  assert.throws(
    () =>
      verifyUnmanagedPolicy({
        ...base,
        readDir: () => {
          const error = new Error("unreadable");
          error.code = "EACCES";
          throw error;
        },
      }),
    /managed policy/,
  );
  assert.throws(
    () =>
      verifyUnmanagedPolicy({
        ...base,
        platform: "darwin",
        execPolicy: () => "managed preferences",
      }),
    /managed policy/,
  );
  assert.throws(
    () =>
      verifyUnmanagedPolicy({
        ...base,
        platform: "darwin",
        execPolicy: () => {
          throw new Error("unknown failure");
        },
      }),
    /managed policy/,
  );
  assert.doesNotThrow(() =>
    verifyUnmanagedPolicy({
      ...base,
      platform: "darwin",
      execPolicy: () => {
        const error = new Error("absent");
        error.status = 1;
        error.stderr = "Error: Domain 'com.anthropic.claudecode' not found.";
        throw error;
      },
    }),
  );
});

test("policy inspection dependency rejects before auth or model access", async (context) => {
  const s = setup(context);
  const provider = createProvider({
    ...s.options,
    verifyPolicy: () => {
      throw new Error("managed policy sentinel");
    },
  });
  await assert.rejects(s.invoke(provider), /managed policy sentinel/);
  assert.equal(s.authCalls.length, 0);
  assert.equal(s.modelCalls.length, 0);
});

test("relative config policy is inspected from the auth and model working directory", async (context) => {
  for (const variable of ["CLAUDE_CONFIG_DIR", "HOME"]) {
    const s = setup(context);
    const relative = `config-${path.basename(s.out)}`;
    const config = path.join(
      s.out,
      relative,
      variable === "HOME" ? ".claude" : "",
    );
    mkdirSync(config, { recursive: true });
    const policy = path.join(config, "remote-settings.json");
    writeFileSync(policy, '{"env":{"ANTHROPIC_API_KEY":"test-only"}}');
    s.options.env = { [variable]: relative };
    const inspected = [];
    s.options.verifyPolicy = (options) =>
      verifyUnmanagedPolicy({
        ...options,
        platform: "linux",
        stat: () => {
          const error = new Error("absent");
          error.code = "ENOENT";
          throw error;
        },
        readDir: (directory) => {
          inspected.push(directory);
          return readdirSync(directory);
        },
      });
    const provider = createProvider(s.options);
    await assert.rejects(s.invoke(provider), /managed policy/);
    assert.deepEqual(inspected, [config]);
    assert.equal(s.authCalls.length, 0);
    assert.equal(s.modelCalls.length, 0);
    assert.equal(existsSync(path.join(s.out, "spend.json")), false);

    rmSync(policy);
    await s.invoke(provider);
    assert.equal(inspected.at(-1), config);
    assert.equal(s.authCalls[0].settings.cwd, s.out);
    assert.equal(s.modelCalls[0].settings.cwd, s.out);
    assert.equal(s.authCalls[0].settings.env[variable], relative);
    assert.deepEqual(s.authCalls[0].settings.env, s.modelCalls[0].settings.env);

    s.options.env = { CLAUDE_CONFIG_DIR: config };
    await s.invoke(createProvider(s.options));
    assert.equal(inspected.at(-1), config);
    assert.equal(s.authCalls[1].settings.env.CLAUDE_CONFIG_DIR, config);
    assert.deepEqual(s.authCalls[1].settings.env, s.modelCalls[1].settings.env);
  }
});
