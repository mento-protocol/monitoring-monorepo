#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const terraformFormatPathspecs = [
  ":(glob)**/*.tf",
  ":(glob)**/*.tfvars",
  ":(glob)**/*.tftest.hcl",
];

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function commandError(command, result) {
  if (result.error) {
    return new Error(`${command} failed: ${result.error.message}`);
  }

  const error = new Error(
    `${command} failed with exit code ${result.status ?? "unknown"}`,
  );
  error.exitCode = result.status ?? 1;
  return error;
}

function decodeGitPaths(output) {
  if (output.length === 0) {
    return [];
  }
  if (output.at(-1) !== 0) {
    throw new Error("git ls-files returned a non-NUL-terminated path list");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) {
      continue;
    }
    if (index > start) {
      paths.push(decoder.decode(output.subarray(start, index)));
    }
    start = index + 1;
  }
  return paths;
}

export function checkTerraformFormat(modulePath, options = {}) {
  const repoRoot = realpathSync(options.repoRoot ?? defaultRepoRoot);
  const requestedModuleRoot = path.resolve(repoRoot, modulePath);
  const moduleRoot = realpathSync(requestedModuleRoot);
  if (!isWithin(repoRoot, moduleRoot)) {
    throw new Error(
      `Terraform module is outside the repository: ${modulePath}`,
    );
  }

  const env = options.env ?? process.env;
  const gitBinary = options.gitBinary ?? "git";
  const terraformBinary = options.terraformBinary ?? "terraform";
  const gitResult = spawnSync(
    gitBinary,
    [
      "-C",
      moduleRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...terraformFormatPathspecs,
    ],
    {
      cwd: repoRoot,
      env,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (gitResult.status !== 0 || gitResult.error) {
    throw commandError("git ls-files", gitResult);
  }

  const targets = [];
  const seen = new Set();
  for (const relativePath of decodeGitPaths(gitResult.stdout)) {
    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);

    const absolutePath = path.resolve(moduleRoot, relativePath);
    if (!isWithin(moduleRoot, absolutePath)) {
      throw new Error(
        `git ls-files returned a path outside the Terraform module: ${relativePath}`,
      );
    }

    let metadata;
    try {
      metadata = lstatSync(absolutePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `Terraform format target must be a regular file: ${relativePath}`,
      );
    }
    targets.push(`./${relativePath}`);
  }

  if (targets.length === 0) {
    throw new Error(
      `no tracked or non-ignored Terraform source files found in ${modulePath}`,
    );
  }

  const terraformResult = spawnSync(
    terraformBinary,
    [`-chdir=${moduleRoot}`, "fmt", "-check", ...targets],
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    },
  );
  if (terraformResult.status !== 0 || terraformResult.error) {
    throw commandError("terraform fmt -check", terraformResult);
  }

  return targets;
}

function main() {
  const [modulePath, ...extraArgs] = process.argv.slice(2);
  if (!modulePath || extraArgs.length > 0) {
    process.stderr.write(
      "Usage: node scripts/terraform-fmt-check.mjs <module-path>\n",
    );
    process.exit(2);
  }

  try {
    checkTerraformFormat(modulePath);
  } catch (error) {
    process.stderr.write(`terraform-fmt-check: ${error.message}\n`);
    process.exit(error.exitCode ?? 1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
