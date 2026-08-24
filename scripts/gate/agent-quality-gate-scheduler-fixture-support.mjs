import { readFile } from "node:fs/promises";

export async function readEvents(path) {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function makeGateHandle(child, metadata) {
  let stdout = "";
  let stderr = "";
  let settled = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      settled = true;
      resolvePromise({
        ...metadata,
        code,
        signal,
        stdout,
        stderr,
        finishedAtMs: Date.now(),
      });
    });
  });
  return {
    ...metadata,
    child,
    done,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get settled() {
      return settled;
    },
  };
}
