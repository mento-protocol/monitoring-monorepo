import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Both Cloud Function source paths must drop generated `coverage/` output:
// the Terraform zip (infra/storage.tf) and the break-glass gcloud upload
// (.gcloudignore, which pulls in .gitignore through `#!include`).
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

describe("function deploy inputs exclude coverage output", () => {
  it("excludes coverage from the Terraform function archive", () => {
    expect(terraformArchiveExcludes()).toContain("coverage");
  });

  it("excludes coverage from the gcloud upload context", () => {
    expect(gcloudIgnorePatterns()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/?coverage\/?$/)]),
    );
  });
});
