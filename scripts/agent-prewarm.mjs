#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const usage = `Usage: scripts/agent-prewarm.mjs [--base <ref>] [--head <ref>] [--changed-paths-file <file>] [--dry-run] [--allow-package-script-changes]

Prewarm Turbo's local cache for the Turbo-backed commands already mapped by
the agent quality gate. The helper only runs commands shaped as:

  pnpm exec turbo run <task> --filter=<package> --cache=local:rw

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
      /^- ((?:[A-Z0-9_]+=[^\s()]+ )*pnpm exec turbo run [^()]+ --filter=@mento-protocol\/[^\s()]+ --cache=local:rw)(?: \(.+\))?$/,
    );
    if (match && !commands.includes(match[1])) {
      commands.push(match[1]);
    }
  }

  return commands;
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

function parseArgs(argv) {
  const forwardedArgs = [];
  let mode = "run";
  let allowPackageScriptChanges = false;

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
      case "-h":
      case "--help":
        return { help: true, mode, forwardedArgs, allowPackageScriptChanges };
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { help: false, mode, forwardedArgs, allowPackageScriptChanges };
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

function main() {
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

  let failures = 0;
  for (const command of commands) {
    console.log();
    console.log(`+ ${command}`);
    const result = spawnSync(command, {
      shell: true,
      stdio: "inherit",
    });

    if (result.error) {
      console.error(`Failed to run command: ${result.error.message}`);
      failures += 1;
      continue;
    }

    if (result.status !== 0) {
      failures += 1;
    }
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
  process.exit(main());
}
