// Offline fixtures shared by the v2 tests; no provider calls or production hooks.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const versionStub =
  '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 99\nprintf "%s\\n" "claude-test-version"\n';

export function temporaryDirectory(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "review-v2-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function copyReviewRepo(context) {
  const directory = temporaryDirectory(context);
  const copy = path.join(directory, "repo");
  const reviewDir = path.join(copy, "scripts/review");
  cpSync(path.join(repoRoot, "scripts/review"), reviewDir, { recursive: true });
  cpSync(
    path.join(repoRoot, "docs/evals/review-skill-v2"),
    path.join(copy, "docs/evals/review-skill-v2"),
    { recursive: true },
  );
  return {
    directory,
    copy,
    reviewDir,
    moduleUrl: (file) => pathToFileURL(path.join(reviewDir, file)).href,
  };
}

export function campaignEnvironment(
  context,
  directory = temporaryDirectory(context),
) {
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const cli = path.join(bin, "claude");
  writeFileSync(cli, versionStub, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  context.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const skillDir = path.join(directory, "skill");
  mkdirSync(skillDir);
  writeFileSync(path.join(skillDir, "SKILL.md"), "Review the code.");
  return { directory, bin, cli, skillDir };
}
