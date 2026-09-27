import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Both Cloud Function source paths must drop generated output that is not a
// build input: the Terraform zip (infra/storage.tf) and the break-glass gcloud
// upload (.gcloudignore, which pulls in .gitignore through `#!include`).
// `dist` is safe to drop because Cloud Build reruns `gcp-build`.
const generatedPaths = [
  "coverage",
  ".eslintcache",
  "dist",
  "node_modules",
  ".turbo",
];
const packageRoot = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(packageRoot, file), "utf8");

function terraformArchiveExcludes(): string[] {
  const block =
    /data "archive_file" "function_source" \{[\s\S]*?excludes\s*=\s*\[([\s\S]*?)\]/.exec(
      read("infra/storage.tf"),
    );
  if (!block) throw new Error("function_source excludes list not found");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function gcloudIgnorePatterns(file = ".gcloudignore"): string[] {
  return read(file)
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const include = /^#!include:(.+)$/.exec(line);
      if (include) return gcloudIgnorePatterns(include[1]);
      return line === "" || line.startsWith("#") ? [] : [line];
    });
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe.each(generatedPaths)("function deploy inputs exclude %s", (path) => {
  it("excludes it from the Terraform function archive", () => {
    expect(terraformArchiveExcludes()).toContain(path);
  });

  it("excludes it from the gcloud upload context", () => {
    const pattern = new RegExp(`^/?${escapeRegExp(path)}/?$`);
    expect(gcloudIgnorePatterns()).toEqual(
      expect.arrayContaining([expect.stringMatching(pattern)]),
    );
  });
});
