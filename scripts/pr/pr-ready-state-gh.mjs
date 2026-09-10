/** GitHub CLI transport for PR probes, including scoped cancellation. */

import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

const GH_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;
const ghAbortScope = new AsyncLocalStorage();

export function withGhAbortSignal(signal, callback) {
  return ghAbortScope.run(signal, callback);
}

function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: ghAbortScope.getStore(),
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failed = false;

    function fail(message) {
      if (failed) return;
      failed = true;
      child.kill();
      reject(new Error(message));
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > GH_OUTPUT_MAX_BYTES) {
        fail(
          `gh ${args.join(" ")} stdout exceeded ${GH_OUTPUT_MAX_BYTES} byte limit`,
        );
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > GH_OUTPUT_MAX_BYTES) {
        fail(
          `gh ${args.join(" ")} stderr exceeded ${GH_OUTPUT_MAX_BYTES} byte limit`,
        );
        return;
      }
      stderr += chunk;
    });
    child.on("error", (err) => {
      fail(`gh ${args.join(" ")} failed: ${err.message}`);
    });
    child.on("close", (status) => {
      if (failed) return;
      if (status !== 0) {
        reject(
          new Error(
            `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}`,
          ),
        );
        return;
      }

      resolve(stdout);
    });
  });
}

export async function ghJson(args) {
  const stdout = await runGh(args);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export function ghApiArgs(repo, args) {
  const ghArgs = ["api"];
  if (repo.host) {
    ghArgs.push("--hostname", repo.host);
  }
  ghArgs.push(...args);
  return ghArgs;
}

export async function ghApiJsonPages(repo, args) {
  const parsed = await ghJson([
    ...ghApiArgs(repo, args),
    "--paginate",
    "--slurp",
  ]);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

export async function ghApiJsonResult(repo, args) {
  try {
    const stdout = await runGh(ghApiArgs(repo, args));
    return {
      ok: true,
      value: stdout.trim() ? JSON.parse(stdout) : null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function ghApiJsonPagesResult(repo, args) {
  try {
    const stdout = await runGh([
      ...ghApiArgs(repo, args),
      "--paginate",
      "--slurp",
    ]);
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return {
      ok: true,
      value: Array.isArray(parsed)
        ? parsed.flatMap((page) => (Array.isArray(page) ? page : [page]))
        : [],
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
