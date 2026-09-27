import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Both alerts Cloud Functions have two upload owners: the Terraform zip
// (archive_file.function_source in main.tf) and the gcloud upload context
// (.gcloudignore). Both must drop generated output that is not a build input.
// `dist` is safe to drop because Cloud Build reruns the package `build` script.
const generatedPaths = ["coverage", "dist", "node_modules", ".turbo"];
const infraRoot = join(__dirname, "..", "..");
const packages = ["onchain-event-handler", "oncall-announcer"];

const read = (pkg: string, file: string) =>
  readFileSync(join(infraRoot, pkg, file), "utf8");

function terraformArchiveExcludes(pkg: string): string[] {
  const block =
    /data "archive_file" "function_source" \{[\s\S]*?excludes\s*=\s*\[([\s\S]*?)\n\s*\]/.exec(
      read(pkg, "main.tf"),
    );
  if (!block) throw new Error(`${pkg}: function_source excludes not found`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function gcloudIgnorePatterns(pkg: string): string[] {
  return read(pkg, ".gcloudignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe.each(packages)("%s deploy inputs", (pkg) => {
  it("parses a non-empty exclusion list from each owner", () => {
    expect(terraformArchiveExcludes(pkg).length).toBeGreaterThan(5);
    expect(gcloudIgnorePatterns(pkg).length).toBeGreaterThan(5);
  });

  it.each(generatedPaths)("excludes %s from the Terraform zip", (path) => {
    expect(terraformArchiveExcludes(pkg)).toContain(path);
  });

  it.each(generatedPaths)("excludes %s from the gcloud upload", (path) => {
    const pattern = new RegExp(`^/?${escapeRegExp(path)}/?$`);
    expect(gcloudIgnorePatterns(pkg)).toEqual(
      expect.arrayContaining([expect.stringMatching(pattern)]),
    );
  });
});
