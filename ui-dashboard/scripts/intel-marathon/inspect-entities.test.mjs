import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("./inspect-entities.mjs", import.meta.url),
);

describe("inspect-entities env validation", () => {
  it("fails with explicit Upstash env names before constructing requests", () => {
    const env = { ...process.env };
    delete env.UPSTASH_REDIS_REST_URL;
    delete env.UPSTASH_REDIS_REST_TOKEN;

    const result = spawnSync(process.execPath, [scriptPath], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing env: UPSTASH_REDIS_REST_URL");
    expect(result.stderr).toContain("UPSTASH_REDIS_REST_TOKEN");
  });
});
