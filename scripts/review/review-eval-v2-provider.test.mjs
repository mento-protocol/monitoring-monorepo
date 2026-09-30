import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
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
import { invokeJudge } from "./review-eval-v2-judge-provider.mjs";
import { claudeArgv } from "./review-eval-run-execution.mjs";
import * as providerModule from "./review-eval-v2-provider.mjs";
import { providerVersion as legacyCapture } from "./review-eval-v2-runner.mjs";

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
  const versionCalls = [];
  const modelCalls = [];
  const options = {
    out,
    repoRoot: out,
    version: "test",
    env: { PATH: "/usr/bin:/bin", ...env },
    verifyPolicy: () => {},
    execVersion: (name, args, settings) => {
      versionCalls.push({ name, args, settings });
      return "test";
    },
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
    versionCalls,
    modelCalls,
    options,
    invoke: (provider) => provider.invoke({ ...request, cwd: out }),
  };
}

test("version capture and provider children select the same CLI after checkout PATH scrubbing", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "v2-cli-resolution-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, "checkout");
  const checkoutBin = path.join(repoRoot, "node_modules/.bin");
  const trustedBin = path.join(root, "trusted-bin");
  const cwd = path.join(root, "fixture");
  for (const directory of [checkoutBin, trustedBin, cwd])
    mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(checkoutBin, "claude"),
    '#!/bin/sh\nprintf "%s\\n" "checkout-cli"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(trustedBin, "claude"),
    `#!/bin/sh
printf '%s\\n' "$PWD" >> "$SHIM_LOG"
if [ "$1" = "--version" ]; then printf '%s\\n' 'provider-cli'; exit 0; fi
if [ "$3" = "auth" ]; then printf '%s\\n' '${JSON.stringify(subscription)}'; exit 0; fi
printf '%s\\n' '{"type":"result","is_error":false,"result":"controlled-shim-result","total_cost_usd":0}'
`,
    { mode: 0o755 },
  );
  const log = path.join(root, "shim.log");
  const env = {
    PATH: `${checkoutBin}${path.delimiter}${trustedBin}`,
    SHIM_LOG: log,
  };
  assert.equal(
    execFileSync("claude", ["--version"], {
      cwd,
      env,
      encoding: "utf8",
    }).trim(),
    "checkout-cli",
    "the unsanitized route must actually resolve the conflicting CLI",
  );
  const oldPath = process.env.PATH;
  process.env.PATH = env.PATH;
  let version;
  try {
    version = (providerModule.providerVersion ?? legacyCapture)({
      repoRoot,
      cwd,
      env,
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
  assert.equal(version, "provider-cli");
  const provider = createProvider({
    out: path.join(root, "evidence"),
    repoRoot,
    version,
    env,
    verifyPolicy: () => {},
  });
  const result = await provider.invoke({ ...request, cwd });
  assert.equal(result.version, version);
  assert.equal(result.envelope.result, "controlled-shim-result");
  const visited = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(
    visited.length,
    5,
    "capture, auth, pre-version, model and post-version use the trusted shim",
  );
  assert.ok(
    visited.every((directory) => realpathSync(directory) === realpathSync(cwd)),
  );
});

test("capture and invocation reject PATH values that depend on the child working directory", async (context) => {
  for (const value of ["", "../outside-bin", "/usr/bin:../outside-bin"]) {
    const s = setup(context, { env: { PATH: value } });
    assert.throws(
      () => providerModule.providerVersion({ ...s.options, cwd: s.out }),
      /provider PATH requires absolute directories/,
    );
    await assert.rejects(
      s.invoke(createProvider(s.options)),
      /provider PATH requires absolute directories/,
    );
    assert.equal(s.versionCalls.length, 0);
    assert.equal(s.authCalls.length, 0);
    assert.equal(s.modelCalls.length, 0);
    assert.equal(existsSync(path.join(s.out, "spend.json")), false);
  }
});

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

test("blind and source judges share auth and capture while preserving their exact tool sets", async (context) => {
  const s = setup(context);
  const provider = createProvider(s.options);
  await s.invoke(provider);
  for (const allowedTools of [[], ["Read", "Grep", "Glob"]]) {
    const maxTurns = allowedTools.length ? 60 : 1;
    await invokeJudge(provider, {
      ...request,
      label: "judge",
      cwd: s.out,
      allowedTools,
      maxTurns,
    });
    const call = s.modelCalls.at(-1);
    assert.equal(
      call.args[call.args.indexOf("--tools") + 1],
      allowedTools.join(","),
    );
    assert.equal(
      call.args[call.args.indexOf("--max-turns") + 1],
      String(maxTurns),
    );
    assert.equal(
      call.args[call.args.indexOf("--permission-mode") + 1],
      "dontAsk",
    );
    for (const flag of [
      "--restricted",
      "--no-session-persistence",
      "--strict-mcp-config",
    ])
      assert.ok(call.args.includes(flag));
    assert.equal(
      call.args[call.args.indexOf("--mcp-config") + 1],
      '{"mcpServers":{}}',
    );
    assert.deepEqual(s.authCalls.at(-1).settings.env, call.settings.env);
    assert.equal(s.authCalls.at(-1).settings.cwd, call.settings.cwd);
  }
  assert.equal(provider.ledger.calls.length, 3);
  assert.equal(readdirSync(path.join(s.out, "calls")).length, 3);
});

test("judge argument builders cannot widen tools or change trusted settings and transport", async (context) => {
  for (const change of [
    (args) =>
      args.map((value, index) =>
        args[index - 1] === "--tools" ? "Bash" : value,
      ),
    (args) => [...args, "--tools", "Read"],
    (args) => [...args, "--tools=Read"],
    (args) => [...args, "--allowed-tools", "Read"],
    (args) => [...args, "--settings", "untrusted.json"],
    (args) =>
      args.map((value, index) =>
        args[index - 1] === "--setting-sources" ? "project" : value,
      ),
    (args) =>
      args.map((value, index) =>
        args[index - 1] === "--output-format" ? "json" : value,
      ),
  ]) {
    const s = setup(context);
    const provider = createProvider(s.options);
    await assert.rejects(
      provider.invoke(
        { ...request, cwd: s.out, allowedTools: [], maxTurns: 1 },
        (input) => change(claudeArgv(input)),
      ),
      /shared invocation boundary/,
    );
    assert.equal(s.authCalls.length, 0);
    assert.equal(s.modelCalls.length, 0);
    assert.equal(existsSync(path.join(s.out, "spend.json")), false);
  }
  const s = setup(context);
  const provider = createProvider(s.options);
  await assert.rejects(
    provider.invoke(
      { ...request, cwd: s.out, allowedTools: [], maxTurns: 1 },
      (input) => {
        input.allowedTools.push("Bash");
        return claudeArgv(input);
      },
    ),
    /shared invocation boundary/,
  );
  assert.equal(s.authCalls.length, 0);
  assert.equal(s.modelCalls.length, 0);
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

test("provider version changes between calls reject the next judge before launch", async (context) => {
  const s = setup(context);
  let installedVersion = "test";
  s.options.execVersion = (name, args, settings) => {
    s.versionCalls.push({ name, args, settings });
    return installedVersion;
  };
  const provider = createProvider(s.options);
  const first = await s.invoke(provider);
  assert.equal(first.version, "test");
  installedVersion = "upgraded";
  await assert.rejects(
    invokeJudge(provider, {
      ...request,
      cwd: s.out,
      allowedTools: [],
      maxTurns: 1,
    }),
    /provider version changed/,
  );
  assert.equal(s.modelCalls.length, 1);
  assert.equal(provider.ledger.calls[1].state, "failed");
  for (const probe of s.versionCalls) {
    assert.equal(probe.name, "claude");
    assert.deepEqual(probe.args, ["--version"]);
    assert.equal(probe.settings.cwd, s.modelCalls[0].settings.cwd);
    assert.deepEqual(probe.settings.env, s.modelCalls[0].settings.env);
  }
  assert.equal(
    s.versionCalls.length,
    3,
    "before/after the first call and before the refused call",
  );
});

test("provider checks its captured version after authentication and before spawn", async (context) => {
  const s = setup(context);
  let installedVersion = "test";
  const originalAuth = s.options.execAuth;
  const order = [];
  s.options.execAuth = (...args) => {
    order.push("auth");
    installedVersion = "upgraded-during-auth";
    return originalAuth(...args);
  };
  s.options.execVersion = () => {
    order.push("version");
    return installedVersion;
  };
  const provider = createProvider(s.options);
  await assert.rejects(s.invoke(provider), /provider version changed/);
  assert.deepEqual(order, ["auth", "version"]);
  assert.equal(s.modelCalls.length, 0);
  const artifact = JSON.parse(
    readFileSync(path.join(s.out, "calls/0000.json"), "utf8"),
  );
  assert.equal(artifact.stdout, "");
  assert.equal(artifact.call.state, "failed");
});

test("runtime changes during a call reject its result while retaining stream and known usage", async (context) => {
  const s = setup(context, { costs: [4] });
  let installedVersion = "test";
  s.options.execVersion = () => installedVersion;
  const originalSpawn = s.options.spawnProcess;
  s.options.spawnProcess = (...args) => {
    const child = originalSpawn(...args);
    installedVersion = "upgraded-during-call";
    return child;
  };
  const provider = createProvider(s.options);
  await assert.rejects(s.invoke(provider), /provider version changed/);
  assert.equal(s.modelCalls.length, 1);
  const artifact = JSON.parse(
    readFileSync(path.join(s.out, "calls/0000.json"), "utf8"),
  );
  assert.ok(artifact.stdout.includes("Final review"));
  assert.equal(artifact.call.state, "failed");
  assert.equal(artifact.call.actual_usd, 4);
});

test("unknown or missing CLI version cannot launch a provider", async (context) => {
  for (const output of ["", " ", null, new Error("private diagnostic")]) {
    const s = setup(context);
    s.options.execVersion = () => {
      if (output instanceof Error) throw output;
      return output;
    };
    await assert.rejects(s.invoke(createProvider(s.options)), (error) => {
      assert.match(error.message, /cannot verify provider version/);
      assert.equal(error.message.includes("private diagnostic"), false);
      return true;
    });
    assert.equal(s.modelCalls.length, 0);
  }
  const s = setup(context);
  assert.throws(
    () => createProvider({ ...s.options, version: "" }),
    /expected provider version/,
  );
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
  s.options.env = { ...s.options.env, CLAUDE_CONFIG_DIR: s.out };
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
    s.options.env = { ...s.options.env, [variable]: relative };
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

    s.options.env = { ...s.options.env, CLAUDE_CONFIG_DIR: config };
    await s.invoke(createProvider(s.options));
    assert.equal(inspected.at(-1), config);
    assert.equal(s.authCalls[1].settings.env.CLAUDE_CONFIG_DIR, config);
    assert.deepEqual(s.authCalls[1].settings.env, s.modelCalls[1].settings.env);
  }
});
