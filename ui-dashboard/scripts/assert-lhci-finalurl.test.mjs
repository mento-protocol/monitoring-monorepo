import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PREVIEW_URL = "https://monitoring-example.vercel.app";
const AUDITED_PATHS = [
  "/",
  "/pools",
  "/volume",
  "/pool/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
];
const SCRIPT_PATH = fileURLToPath(
  new URL("./assert-lhci-finalurl.mjs", import.meta.url),
);

let fixtureRoot;
let reportDir;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "lhci-finalurl-"));
  reportDir = join(fixtureRoot, ".lighthouseci");
  mkdirSync(reportDir);
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeReports(paths) {
  paths.forEach((path, index) => {
    const finalUrl = new URL(path, PREVIEW_URL).href;
    const lhr = {
      requestedUrl: finalUrl,
      finalUrl,
      runtimeError: { code: "NO_ERROR" },
      audits: {
        "network-requests": {
          details: { items: [{ url: finalUrl, statusCode: 200 }] },
        },
      },
    };
    writeFileSync(
      join(reportDir, `lhr-${String(index).padStart(2, "0")}.json`),
      JSON.stringify(lhr),
    );
  });
}

function runGuard() {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: { ...process.env, PREVIEW_URL },
  });
}

describe("assert-lhci-finalurl", () => {
  it("accepts exactly three successful reports for each audited path", () => {
    writeReports(AUDITED_PATHS.flatMap((path) => Array(3).fill(path)));

    const result = runGuard();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Audited 12 report(s)");
    expect(result.stdout).toContain(
      "All audited URLs match the expected host + path set.",
    );
  });

  it("rejects a missing Lighthouse run", () => {
    const paths = AUDITED_PATHS.flatMap((path) => Array(3).fill(path));
    writeReports(paths.slice(0, -1));

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Expected exactly 12 Lighthouse reports (3 runs × 4 paths), found 11",
    );
  });

  it("rejects an extra Lighthouse run", () => {
    writeReports([
      ...AUDITED_PATHS.flatMap((path) => Array(3).fill(path)),
      "/",
    ]);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Expected exactly 12 Lighthouse reports (3 runs × 4 paths), found 13",
    );
  });

  it("rejects duplicated coverage even when the total report count is 12", () => {
    writeReports([
      ...Array(4).fill("/"),
      ...Array(3).fill("/pools"),
      ...Array(2).fill("/volume"),
      ...Array(3).fill(AUDITED_PATHS[3]),
    ]);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Expected 3 Lighthouse reports for /, found 4",
    );
    expect(result.stderr).toContain(
      "Expected 3 Lighthouse reports for /volume, found 2",
    );
  });

  it("rejects a report for a path outside the exact allowlist", () => {
    const paths = AUDITED_PATHS.flatMap((path) => Array(3).fill(path));
    paths[0] = "/unexpected";
    writeReports(paths);

    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Path mismatch");
    expect(result.stderr).toContain("got /unexpected");
  });
});
