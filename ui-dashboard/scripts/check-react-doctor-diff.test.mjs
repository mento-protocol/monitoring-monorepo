import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const WRAPPER_PATH = fileURLToPath(
  new URL("./check-react-doctor-diff.sh", import.meta.url),
);

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  expect(
    result.status,
    `${command} ${args.join(" ")} failed:\n${result.stderr}`,
  ).toBe(0);
  return result.stdout.trim();
}

it("restores a detached HEAD after forwarding the exact React Doctor diff base", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "react-doctor-diff-"));
  const binDir = join(fixtureRoot, "bin");
  const scriptsDir = join(fixtureRoot, "ui-dashboard", "scripts");
  const wrapperPath = join(scriptsDir, "check-react-doctor-diff.sh");
  const pnpmPath = join(binDir, "pnpm");
  const argsPath = join(fixtureRoot, "pnpm-args.json");
  const baseRef = "origin/test";

  try {
    mkdirSync(binDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(fixtureRoot, "README.md"), "fixture\n");
    copyFileSync(WRAPPER_PATH, wrapperPath);
    writeFileSync(
      pnpmPath,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PNPM_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
`,
    );
    chmodSync(pnpmPath, 0o755);

    run("git", ["init", "-q"], fixtureRoot);
    run("git", ["add", "README.md"], fixtureRoot);
    run(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=React Doctor Test",
        "commit",
        "-qm",
        "init",
      ],
      fixtureRoot,
    );
    const originalHead = run(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      fixtureRoot,
    );
    run("git", ["switch", "--detach", "HEAD"], fixtureRoot);

    run("/bin/bash", [wrapperPath, baseRef], fixtureRoot, {
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        PNPM_ARGS_FILE: argsPath,
      },
    });

    expect(run("git", ["rev-parse", "--abbrev-ref", "HEAD"], fixtureRoot)).toBe(
      "HEAD",
    );
    expect(run("git", ["rev-parse", "--verify", "HEAD"], fixtureRoot)).toBe(
      originalHead,
    );
    const branches = run(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      fixtureRoot,
    ).split("\n");
    expect(
      branches.some((branch) => branch.startsWith("__react_doctor_scan")),
    ).toBe(false);
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
      "--filter",
      "@mento-protocol/ui-dashboard",
      "react-doctor",
      "--diff",
      baseRef,
      "--fail-on",
      "warning",
      "--offline",
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
