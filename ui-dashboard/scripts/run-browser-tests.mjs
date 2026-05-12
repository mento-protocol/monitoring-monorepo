#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const nextEnvUrl = new URL("../next-env.d.ts", import.meta.url);
const originalNextEnv = existsSync(nextEnvUrl)
  ? await readFile(nextEnvUrl, "utf8")
  : null;

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "playwright",
      ["test", "--config=playwright.config.ts", ...process.argv.slice(2)],
      {
        env: process.env,
        shell: process.platform === "win32",
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

let exitCode = 1;
try {
  exitCode = await runPlaywright();
} finally {
  if (originalNextEnv !== null) {
    await writeFile(nextEnvUrl, originalNextEnv);
  }
}

process.exit(exitCode);
