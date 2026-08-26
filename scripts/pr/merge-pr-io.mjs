/**
 * The side effects behind the sanctioned merge wrapper: child processes, the
 * operator's terminal, and the consent ledger.
 *
 * `scripts/pr/merge-pr.mjs` orders the gates and `scripts/pr/merge-pr-core.mjs`
 * decides them; this module is where the process actually touches something.
 * Keeping it separate is what lets the suite drive every gate without a real
 * `gh`, and keeps all three files under the 600-line soft cap
 * (`docs/adr/0065-scripts-file-size-watchlist-scope.md`).
 *
 * Tests: scripts/pr/merge-pr.test.mjs
 */

import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { CONSENT_LOG_BASENAME, MergeRefusal } from "./merge-pr-core.mjs";

export function runCommand(command, args, { spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(new Error(`${command} ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit ${code}:\n${stderr}`,
        ),
      );
    });
  });
}

export const runGit = (args) => runCommand("git", args);

/** The merge itself streams to the operator's terminal instead of a buffer. */
export function runGhInherit(args, { spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn("gh", args, { stdio: "inherit" });
    child.on("error", (err) => {
      reject(new Error(`gh ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`gh ${args.join(" ")} failed with exit ${code}`));
    });
  });
}

export async function promptLine({ stdin, stdout, question }) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Append one consent record to the repository-root ledger.
 *
 * @param write injected only so the suite can simulate a short write; the
 *   default is the real `fs.writeSync`.
 */
export async function appendConsentRecord({ record, git, write = writeSync }) {
  let repoRoot;
  try {
    repoRoot = (await git(["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    throw new MergeRefusal(
      `unable to resolve the repository root for the consent record: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!repoRoot) {
    throw new MergeRefusal(
      "unable to resolve the repository root for the consent record",
    );
  }

  const target = path.join(repoRoot, CONSENT_LOG_BASENAME);

  // The ledger is gitignored, so the agent this wrapper constrains can create
  // the path before a human ever runs the command. A plain append would follow
  // a symlink planted there and write into whatever file the operator's own
  // account can reach. `O_NOFOLLOW` refuses a symlinked final component,
  // `O_NONBLOCK` keeps a planted FIFO from hanging the open, and the `fstat`
  // on the descriptor we actually hold rejects anything that is not a regular
  // file. Fail closed if the platform cannot express `O_NOFOLLOW` at all.
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new MergeRefusal(
      `unable to open ${target} without following symlinks on this platform`,
    );
  }

  let fd;
  try {
    fd = openSync(
      target,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
  } catch (err) {
    throw new MergeRefusal(
      `unable to record consent in ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new MergeRefusal(
        `${target} is not a regular file; refusing to record consent through it`,
      );
    }
    // `O_NOFOLLOW` rejects a symlink, but a hard link is the same inode under
    // another name and passes every test above, so the same planted-path attack
    // works with `ln` instead of `ln -s`. A ledger this wrapper owns has
    // exactly one link.
    if (stats.nlink !== 1) {
      throw new MergeRefusal(
        `${target} has ${stats.nlink} hard links, so it names another file too; refusing to record consent through it`,
      );
    }

    const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    // A full disk or an exhausted quota can make `writeSync` return a short
    // count rather than throw. Ignoring it would leave a truncated, unparseable
    // record behind a reported success.
    const written = write(fd, payload);
    if (written !== payload.length) {
      throw new MergeRefusal(
        `${target} accepted only ${written} of ${payload.length} bytes, so the consent record is incomplete; nothing was merged`,
      );
    }
  } catch (err) {
    if (err instanceof MergeRefusal) throw err;
    throw new MergeRefusal(
      `unable to record consent in ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    closeSync(fd);
  }
  return target;
}
