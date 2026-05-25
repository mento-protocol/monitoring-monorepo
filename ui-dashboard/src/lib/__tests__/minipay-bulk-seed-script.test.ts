import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = join(process.cwd(), "scripts/minipay-bulk-seed.mjs");

describe("minipay-bulk-seed script safety", () => {
  it("rejects execution-id reuse before writing minipay:lastBlock", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");

    expect(source).toContain("if (process.argv[2])");
    expect(source).toContain("Execution-id reuse is disabled");
    expect(source).toContain("executeQuery(0)");
    expect(source).not.toContain("REUSE_EXEC_ID");
  });
});
