// Subscription-only execution with durable API-equivalent usage telemetry.
import { spawn, execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  claudeArgv,
  scrubbedEnv,
  claudeStreamEnvelope,
} from "./review-eval-run-execution.mjs";

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}

// Empty setting sources do not disable managed policy. Refuse its presence
// instead of attempting to reproduce the CLI's dynamic policy merge.
export function verifyUnmanagedPolicy({
  env,
  cwd = process.cwd(),
  platform = process.platform,
  stat = lstatSync,
  readDir = readdirSync,
  execPolicy = execFileSync,
}) {
  const fail = () => {
    throw new Error(
      "cannot attest subscription under managed policy; use a verified unmanaged environment",
    );
  };
  const config = path.resolve(
    cwd,
    env.CLAUDE_CONFIG_DIR || path.join(env.HOME || homedir(), ".claude"),
  );
  for (const root of [
    "/Library/Application Support/ClaudeCode",
    "/etc/claude-code",
  ]) {
    for (const name of ["managed-settings.json", "managed-settings.d"]) {
      try {
        stat(path.join(root, name));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        fail();
      }
      fail();
    }
  }
  try {
    if (readDir(config).some((name) => name.includes("remote-settings")))
      fail();
  } catch (error) {
    if (error.code !== "ENOENT") fail();
  }
  if (platform === "darwin") {
    try {
      execPolicy("/usr/bin/defaults", ["read", "com.anthropic.claudecode"], {
        env: { ...env, LC_ALL: "C", LANG: "C" },
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (
        error.status === 1 &&
        /(?:Domain .* not found|domain.*does not exist)/is.test(
          String(error.stderr),
        )
      )
        return;
      fail();
    }
    fail();
  } else if (platform !== "linux") fail();
}

// Auth and model calls use the same environment, cwd and empty settings sources.
// Refuse route overrides rather than silently switching billing modes.
export function verifySubscription({
  cwd,
  env,
  execAuth = execFileSync,
  verifyPolicy = verifyUnmanagedPolicy,
}) {
  if (
    Object.entries(env).some(
      ([name, value]) =>
        value &&
        /^(?:ANTHROPIC_|CLAUDE_SECURESTORAGE_CONFIG_DIR$|CLAUDE_CODE_(?:USE_|API_KEY|OAUTH_|MANAGED_SETTINGS|REMOTE_SETTINGS|MOCK_REMOTE_SETTINGS|BRIDGE_CHILD_MACHINE_SETTINGS|POLICY_HELPER|PROVIDER_MANAGED_BY_HOST))/.test(
          name,
        ),
    )
  ) {
    throw new Error(
      "subscription authentication override present; unset provider, API-key, or token overrides",
    );
  }
  verifyPolicy({ env, cwd });
  let status;
  try {
    status = JSON.parse(
      execAuth(
        "claude",
        ["--setting-sources", "", "auth", "status", "--json"],
        {
          cwd,
          env,
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch {
    throw new Error(
      "cannot verify Claude subscription; inspect claude auth status",
    );
  }
  if (
    status?.loggedIn !== true ||
    status.authMethod !== "claude.ai" ||
    status.apiProvider !== "firstParty" ||
    !["pro", "max", "team", "enterprise"].includes(status.subscriptionType)
  ) {
    throw new Error(
      "v2 requires a verified Claude subscription; API and unknown authentication are unsupported",
    );
  }
}

export function reserveCall(ledger, label) {
  const call = {
    id: ledger.calls.length,
    label,
    state: "reserved",
    reserved_usd: null,
    charged_usd: null,
    actual_usd: null,
    started_at: new Date().toISOString(),
  };
  ledger.calls.push(call);
  return call;
}

export function settleCall(call, result) {
  const cost = result?.total_cost_usd;
  const known = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
  call.actual_usd = known ? cost : null;
  call.charged_usd = known ? cost : call.reserved_usd;
  call.state = result?.is_error === false ? "completed" : "failed";
  call.finished_at = new Date().toISOString();
}

export function createProvider({
  out,
  limit,
  repoRoot,
  version,
  env = process.env,
  execAuth = execFileSync,
  verifyPolicy = verifyUnmanagedPolicy,
  spawnProcess = spawn,
}) {
  if (limit !== undefined && limit !== null)
    throw new Error(
      "dollar limits are unsupported for subscription runs; create a new plan",
    );
  const file = path.join(out, "spend.json");
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    ledger = { billing_mode: "subscription", limit_usd: null, calls: [] };
  }
  if (ledger.billing_mode !== "subscription" || ledger.limit_usd !== null)
    throw new Error(
      "legacy dollar-budget ledger; create a new subscription plan and preserve existing evidence",
    );
  const invoke = async ({
    label,
    prompt,
    model,
    effort,
    cwd,
    systemPrompt = "",
    allowedTools = [],
    maxTurns = 8,
  }) => {
    const callEnv = scrubbedEnv({ env, roots: [repoRoot] });
    verifySubscription({ cwd, env: callEnv, execAuth, verifyPolicy });
    const call = reserveCall(ledger, label);
    writeJson(file, ledger);
    // Provider subprocesses cannot launch more providers, edit fixtures, or post.
    // Restricted mode also confines file access to the fixture directory.
    const readTools = allowedTools.filter((tool) =>
      ["Read", "Grep", "Glob"].includes(tool),
    );
    const args = [
      ...claudeArgv({
        prompt,
        model,
        effort,
        allowedTools: readTools,
        maxTurns,
      }),
      "--no-session-persistence",
      "--restricted",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ];
    args[args.indexOf("--permission-mode") + 1] = "dontAsk";
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    args.push(
      "--disallowed-tools",
      "Agent",
      "Task",
      "Write",
      "Edit",
      "Bash(codex:*)",
      "Bash(claude:*)",
    );
    let stdout = "";
    let stderr = "";
    try {
      await new Promise((resolve, reject) => {
        const child = spawnProcess("claude", args, {
          cwd,
          env: callEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("provider timeout (20 minutes)"));
        }, 1_200_000);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.length > 64 * 1024 * 1024) {
            child.kill("SIGKILL");
            reject(new Error("provider output exceeded 64 MiB"));
          }
        });
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-4000);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`provider exited ${code}: ${stderr}`));
        });
      });
      const events = stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line));
      const terminal = events
        .filter((event) => event.type === "result" && !event.parent_tool_use_id)
        .at(-1);
      const envelope = claudeStreamEnvelope(stdout, { resultText: "final" });
      // The v1 envelope defaults a missing cost to zero. Preserve unknown here.
      envelope.total_cost_usd = terminal?.total_cost_usd ?? null;
      settleCall(call, envelope);
      if (envelope.is_error || !envelope.result.trim())
        throw new Error("provider returned an incomplete result");
      return { stream: stdout, envelope, version, call_id: call.id };
    } catch (error) {
      call.state = "failed";
      call.error = error.message;
      call.finished_at = new Date().toISOString();
      throw error;
    } finally {
      const streamFile = path.join(
        out,
        "calls",
        `${String(call.id).padStart(4, "0")}.json`,
      );
      writeJson(streamFile, { label, stdout, stderr, call });
      writeJson(file, ledger);
    }
  };
  return { invoke, ledger };
}
