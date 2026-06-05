#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const maxCapturedBytes = 20 * 1024 * 1024;
const defaultParallelism = 2;

const usage = `Usage: scripts/agent-prewarm.mjs [--base <ref>] [--head <ref>] [--changed-paths-file <file>] [--dry-run] [--allow-package-script-changes] [--parallel <n>]

Prewarm Turbo's local cache for the Turbo-backed commands already mapped by
the agent quality gate. The helper only runs commands shaped as:

  pnpm exec turbo run <task> --filter=<package> [--filter=<package> ...] --cache=local:rw

It deliberately ignores deploy, Terraform, mutation, codegen, install, and
other non-Turbo commands.

Options:
  --base <ref>   Base ref for changed-path detection. Default: origin/main.
  --head <ref>   Head ref for changed-path detection. Default: HEAD.
  --changed-paths-file <file>
                 Read changed paths from a newline-delimited file instead of git.
  --dry-run      Print the Turbo commands without running them.
  --allow-package-script-changes
                 With run mode, acknowledge package manifest/script changes
                 before executing Turbo-backed package scripts.
  --parallel <n> Execute up to n Turbo commands concurrently. Default: 2.
                 Can also be set with AGENT_PREWARM_PARALLELISM.
  -h, --help     Show this help.
`;

export function extractTurboPrewarmCommands(gateOutput) {
  const commands = [];
  let inCommandBlock = false;

  for (const line of gateOutput.split(/\r?\n/)) {
    if (line === "Mapped safe local commands:") {
      inCommandBlock = true;
      continue;
    }

    if (!inCommandBlock) continue;
    if (line.trim() === "") break;

    const match = line.match(
      /^- ((?:[A-Z0-9_]+=[^\s()]+ )*pnpm exec turbo run [^()]+(?: --filter=@mento-protocol\/[^\s()]+)+ --cache=local:rw)(?: \(.+\))?$/,
    );
    if (match && !commands.includes(match[1])) {
      commands.push(match[1]);
    }
  }

  return commands;
}

export function isDashboardNextWorkspaceCommand(command) {
  return (
    command ===
      "pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw" ||
    command ===
      "pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw"
  );
}

export function splitPrewarmCommands(commands) {
  const serialCommands = [];
  const parallelCommands = [];

  for (const command of commands) {
    if (isDashboardNextWorkspaceCommand(command)) {
      serialCommands.push(command);
    } else {
      parallelCommands.push(command);
    }
  }

  return { serialCommands, parallelCommands };
}

export function hasPackageScriptRisk(gateOutput) {
  let inChangedPaths = false;

  for (const line of gateOutput.split(/\r?\n/)) {
    if (line === "Changed paths:") {
      inChangedPaths = true;
      continue;
    }

    if (!inChangedPaths) continue;
    if (line.trim() === "") break;

    const match = line.match(/^- (.+)$/);
    if (!match) continue;

    const path = match[1];
    if (
      path === "package.json" ||
      path.endsWith("/package.json") ||
      path === "pnpm-lock.yaml" ||
      path === "pnpm-workspace.yaml" ||
      path === "pnpmfile.cjs" ||
      path === ".pnpmfile.cjs" ||
      path === ".npmrc" ||
      path.endsWith("/.npmrc")
    ) {
      return true;
    }
  }

  return false;
}

export function parseParallelism(value, label = "--parallel") {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
    throw new Error(`${label} requires a positive integer`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const forwardedArgs = [];
  let mode = "run";
  let allowPackageScriptChanges = false;
  let parallelism = parseParallelism(
    process.env.AGENT_PREWARM_PARALLELISM ?? String(defaultParallelism),
    "AGENT_PREWARM_PARALLELISM",
  );

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--base":
      case "--head":
      case "--changed-paths-file": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error(`${arg} requires a value`);
        }
        forwardedArgs.push(arg, value);
        index += 1;
        break;
      }
      case "--dry-run":
        mode = "dry-run";
        break;
      case "--allow-package-script-changes":
        allowPackageScriptChanges = true;
        break;
      case "--parallel":
      case "--jobs": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error(`${arg} requires a value`);
        }
        parallelism = parseParallelism(value, arg);
        index += 1;
        break;
      }
      case "-h":
      case "--help":
        return {
          help: true,
          mode,
          forwardedArgs,
          allowPackageScriptChanges,
          parallelism,
        };
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return {
    help: false,
    mode,
    forwardedArgs,
    allowPackageScriptChanges,
    parallelism,
  };
}

function runGate(forwardedArgs) {
  return spawnSync(
    "scripts/agent-quality-gate.sh",
    ["--dry-run", ...forwardedArgs],
    {
      encoding: "utf8",
      shell: false,
      stdio: "pipe",
    },
  );
}

function createCollector() {
  let bytes = 0;
  let truncated = false;
  const chunks = [];

  return {
    append(chunk) {
      if (bytes >= maxCapturedBytes) {
        truncated = true;
        return;
      }

      const remaining = maxCapturedBytes - bytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        return;
      }

      chunks.push(chunk);
      bytes += chunk.length;
    },
    text() {
      const suffix = truncated ? "\n[output truncated after 20 MiB]\n" : "";
      return `${Buffer.concat(chunks).toString("utf8")}${suffix}`;
    },
  };
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function runCommand(command) {
  const stdout = createCollector();
  const stderr = createCollector();
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));

    child.on("error", (error) => {
      resolve({
        command,
        error,
        status: 1,
        elapsedMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });

    child.on("close", (status, signal) => {
      resolve({
        command,
        signal,
        status: status ?? 1,
        elapsedMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
  });
}

export function runCommandsParallel(commands, parallelism) {
  const results = new Array(commands.length);
  let nextIndex = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    if (commands.length === 0) {
      resolve([]);
      return;
    }

    const launch = () => {
      while (active < parallelism && nextIndex < commands.length) {
        const commandIndex = nextIndex;
        const command = commands[commandIndex];
        nextIndex += 1;
        active += 1;

        runCommand(command)
          .then((result) => {
            results[commandIndex] = result;
            active -= 1;
            if (nextIndex >= commands.length && active === 0) {
              resolve(results);
              return;
            }
            launch();
          })
          .catch(reject);
      }
    };

    launch();
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.stderr.write(usage);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(usage);
    return 0;
  }

  const gateResult = runGate(parsed.forwardedArgs);
  if (gateResult.error) {
    console.error(
      `Failed to invoke agent quality gate: ${gateResult.error.message}`,
    );
    return 1;
  }

  if (gateResult.status !== 0) {
    process.stdout.write(gateResult.stdout ?? "");
    process.stderr.write(gateResult.stderr ?? "");
    return gateResult.status ?? 1;
  }

  const commands = extractTurboPrewarmCommands(gateResult.stdout ?? "");
  const packageScriptRisk = hasPackageScriptRisk(gateResult.stdout ?? "");

  console.log("Agent prewarm");
  console.log();

  if (commands.length === 0) {
    console.log(
      "No Turbo-backed quality-gate commands mapped; nothing to prewarm.",
    );
    return 0;
  }

  console.log("Turbo commands:");
  for (const command of commands) {
    console.log(`- ${command}`);
  }

  if (parsed.mode === "dry-run") {
    console.log();
    console.log(
      "Dry run only. Re-run without --dry-run to execute the Turbo commands.",
    );
    return 0;
  }

  if (packageScriptRisk && !parsed.allowPackageScriptChanges) {
    console.error(
      "Refusing to prewarm because package manifests or lockfile changed.",
    );
    console.error(
      "Review package scripts, lifecycle hooks, and dependency install scripts first, then re-run with --allow-package-script-changes if they are safe.",
    );
    return 2;
  }

  console.log();
  console.log(`Running Turbo commands with parallelism ${parsed.parallelism}.`);
  for (const command of commands) {
    console.log(`+ ${command}`);
  }

  // Keep dashboard .next writers/readers out of the prewarm parallel pool:
  // test:browser starts a dev server, while size-limit runs build first.
  const { serialCommands, parallelCommands } = splitPrewarmCommands(commands);
  let failures = 0;
  const serialResults = await runCommandsParallel(serialCommands, 1);
  const parallelResults = await runCommandsParallel(
    parallelCommands,
    parsed.parallelism,
  );
  const results = [...serialResults, ...parallelResults];
  for (const result of results) {
    if (result.error) {
      console.error(`Failed to run command: ${result.error.message}`);
      failures += 1;
      continue;
    }

    if (result.status !== 0) {
      console.error();
      console.error(
        `Command failed after ${formatDuration(result.elapsedMs)}: ${result.command}`,
      );
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.signal) {
        console.error(`Command terminated by signal: ${result.signal}`);
      }
      failures += 1;
      continue;
    }

    // Successful Turbo output is intentionally suppressed here. Parallel runs
    // otherwise interleave progress logs; failures replay captured output.
    console.log(`✓ ${result.command} (${formatDuration(result.elapsedMs)})`);
  }

  if (failures > 0) {
    console.error();
    console.error(`${failures} Turbo prewarm command(s) failed.`);
    return 1;
  }

  console.log();
  console.log("Turbo prewarm complete.");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
