// Durable reservations bound a sequential campaign, including failed calls.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
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

export function reserveCall(ledger, limit, cap, label) {
  const spent = ledger.calls.reduce((sum, call) => sum + call.charged_usd, 0);
  const remaining = limit - spent;
  if (remaining < 0.01) throw new Error("campaign budget exhausted");
  const reservation = Math.floor(Math.min(cap, remaining) * 100) / 100;
  const call = {
    id: ledger.calls.length,
    label,
    state: "reserved",
    reserved_usd: reservation,
    charged_usd: reservation,
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
  reviewerCap = 5,
  graderCap = 2,
  spawnProcess = spawn,
}) {
  const file = path.join(out, "spend.json");
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    ledger = { limit_usd: limit, calls: [] };
  }
  if (ledger.limit_usd !== limit)
    throw new Error("campaign budget differs from stored ledger");
  const invoke = async ({
    label,
    prompt,
    model,
    effort,
    cwd,
    systemPrompt = "",
    reviewer = false,
    allowedTools = [],
    maxTurns = 8,
  }) => {
    const call = reserveCall(
      ledger,
      limit,
      reviewer ? reviewerCap : graderCap,
      label,
    );
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
      "--max-budget-usd",
      String(call.reserved_usd),
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
          env: scrubbedEnv({ roots: [repoRoot] }),
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
