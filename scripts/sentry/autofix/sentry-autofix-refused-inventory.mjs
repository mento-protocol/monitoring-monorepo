/**
 * Bounded, read-only inventory of refused Sentry queue stubs for the autofix
 * tracker record. This is deliberately separate from selection: the Search
 * API read is an operator report and is not part of the selector's gh-call
 * budget or decision surface.
 *
 * The runner is injectable so tests can exercise both the exact request and
 * every fail-closed parsing path without a GitHub token.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REFUSED_INVENTORY_LIMIT = 10;
export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const REFUSED_INVENTORY_TIMEOUT_MS = 15_000;
export const REFUSED_INVENTORY_KILL_GRACE_MS = 100;

export function refusedInventoryArgs(repo) {
  return [
    "api",
    "search/issues",
    "--method",
    "GET",
    "-f",
    `q=repo:${repo} is:issue label:"sentry-triage" label:"sentry:fix-refused"`,
    "-f",
    "sort=created",
    "-f",
    "order=asc",
    "-f",
    `per_page=${REFUSED_INVENTORY_LIMIT}`,
  ];
}

function unknownInventory() {
  return { state: "unknown" };
}

function isPositiveIssueNumber(value) {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    String(value) === String(Math.trunc(value))
  );
}

function validIssueList(issues, count) {
  if (
    !Array.isArray(issues) ||
    issues.length !== Math.min(count, REFUSED_INVENTORY_LIMIT)
  ) {
    return false;
  }
  const seen = new Set();
  for (const number of issues) {
    if (!isPositiveIssueNumber(number) || seen.has(number)) return false;
    seen.add(number);
  }
  return true;
}

/** Parse and validate the raw Search API response. */
export function parseRefusedStubInventory(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout));
  } catch {
    return unknownInventory();
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.incomplete_results !== false ||
    !Number.isSafeInteger(parsed.total_count) ||
    parsed.total_count < 0 ||
    !Array.isArray(parsed.items)
  ) {
    return unknownInventory();
  }

  const issues = [];
  for (const item of parsed.items) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !isPositiveIssueNumber(item.number)
    ) {
      return unknownInventory();
    }
    issues.push(item.number);
  }

  if (!validIssueList(issues, parsed.total_count)) return unknownInventory();
  return { state: "known", count: parsed.total_count, issues };
}

/** Parse the helper's JSON result before it reaches the public tracker body. */
export function parseRefusedStubInventoryResult(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return unknownInventory();
    }
  }
  if (parsed?.state === "unknown") return unknownInventory();
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.state !== "known" ||
    !Number.isSafeInteger(parsed.count) ||
    parsed.count < 0 ||
    !validIssueList(parsed.issues, parsed.count)
  ) {
    return unknownInventory();
  }
  return { state: "known", count: parsed.count, issues: [...parsed.issues] };
}

export function runGhWithTimeout(
  args,
  {
    spawnFn = spawn,
    timeoutMs = REFUSED_INVENTORY_TIMEOUT_MS,
    killGraceMs = REFUSED_INVENTORY_KILL_GRACE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let childDone = false;
    let timer;
    let killTimer;
    let stdout = "";
    let stderr = "";

    const clearKillTimer = () => {
      if (killTimer !== undefined) {
        clearTimeoutFn(killTimer);
        killTimer = undefined;
      }
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeoutFn(timer);
      clearKillTimer();
      callback(value);
    };

    const markChildDone = () => {
      childDone = true;
      clearKillTimer();
    };

    try {
      child = spawnFn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(reject, error);
      return;
    }

    const failOnTimeout = () => {
      const error = new Error(`gh search read timed out after ${timeoutMs}ms`);
      // Settle before killing. Some child implementations emit `close`
      // synchronously from kill(), and the timeout must remain the cause.
      finish(reject, error);
      let terminated = false;
      try {
        terminated = child.kill("SIGTERM");
      } catch {
        // Try the forced path below if SIGTERM was rejected.
      }
      if (terminated === false) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The read is already settled as unknown. There is no safe recovery
          // path if a child implementation rejects both termination requests.
        }
      } else if (!childDone) {
        killTimer = setTimeoutFn(() => {
          killTimer = undefined;
          if (childDone) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // The read is already settled as unknown.
          }
        }, killGraceMs);
      }
    };

    timer = setTimeoutFn(failOnTimeout, timeoutMs);
    try {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        markChildDone();
        finish(reject, error);
      });
      child.on("close", (status) => {
        markChildDone();
        if (status === 0) {
          finish(resolve, stdout);
        } else {
          finish(
            reject,
            new Error(`gh search read failed with exit ${status}: ${stderr}`),
          );
        }
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

function defaultRunGh(args) {
  return runGhWithTimeout(args);
}

/** Read once and fail closed for all command and response failures. */
export async function readRefusedStubInventory(
  { repo = DEFAULT_REPO } = {},
  { runGh = defaultRunGh } = {},
) {
  try {
    const stdout = await runGh(refusedInventoryArgs(repo));
    return parseRefusedStubInventory(stdout);
  } catch {
    return unknownInventory();
  }
}

async function main() {
  const repoIndex = process.argv.indexOf("--repo");
  const repo = repoIndex === -1 ? DEFAULT_REPO : process.argv[repoIndex + 1];
  const result =
    typeof repo === "string" && repo.length > 0
      ? await readRefusedStubInventory({ repo })
      : unknownInventory();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
