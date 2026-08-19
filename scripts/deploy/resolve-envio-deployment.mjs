#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const target = process.argv[2] ?? "";
const input = readFileSync(0, "utf8");
const data = JSON.parse(input);
const deployments = [...(data.data?.deployments ?? [])].sort((a, b) =>
  b.created_time.localeCompare(a.created_time),
);

if (!target) {
  process.stdout.write(deployments[0]?.commit_hash ?? "");
  process.exit(0);
}

let verifiedTarget = "";
try {
  verifiedTarget = execFileSync(
    "git",
    ["rev-parse", "--verify", `${target}^{commit}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
} catch {
  // Non-git strings are allowed only when they are prefixes of Envio's
  // registered short commit ids.
}

const matches = deployments.filter(
  (deployment) =>
    deployment.commit_hash.startsWith(target) ||
    (verifiedTarget && verifiedTarget.startsWith(deployment.commit_hash)),
);

if (matches.length > 1) {
  console.error(
    `Ambiguous deployment commit ${target} matches: ${matches
      .map((deployment) => deployment.commit_hash)
      .join(", ")}`,
  );
  process.exit(2);
}

process.stdout.write(matches[0]?.commit_hash ?? "");
