import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const compiler = require.resolve("typescript/bin/tsc");

it("ships a bridge API usable by packed NodeNext consumers with library checking", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-package-"));
  try {
    const staged = join(root, "staged");
    mkdirSync(staged);
    copyFileSync(
      join(packageRoot, "package.json"),
      join(staged, "package.json"),
    );
    const manifest = JSON.parse(
      readFileSync(join(staged, "package.json"), "utf8"),
    ) as { files: string[] };
    for (const file of manifest.files.filter((file) => file.endsWith(".json")))
      copyFileSync(join(packageRoot, file), join(staged, file));
    // Emit into isolation so this test neither trusts stale dist nor races workspace builds.
    execFileSync(
      process.execPath,
      [
        compiler,
        "-p",
        join(packageRoot, "tsconfig.json"),
        "--outDir",
        join(staged, "dist"),
      ],
      { stdio: "pipe" },
    );
    const [pack] = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          staged,
          "--ignore-scripts",
          "--cache",
          join(root, "npm-cache"),
          "--pack-destination",
          root,
          "--json",
        ],
        { encoding: "utf8" },
      ),
    ) as [{ filename: string; files: { path: string }[] }];
    expect(pack.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "bridge-thresholds.json",
        "dist/bridge-status.js",
        "dist/bridge-status.d.ts",
      ]),
    );
    const consumer = join(root, "consumer");
    const installed = join(consumer, "node_modules/@mento-protocol/config");
    mkdirSync(installed, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      join(root, pack.filename),
      "-C",
      installed,
      "--strip-components=1",
    ]);
    writeFileSync(
      join(consumer, "index.mts"),
      `
import { deriveBridgeStatus, BRIDGE_STUCK_THRESHOLD_SECONDS, type BridgeInFlightStatus } from "@mento-protocol/config/bridge-status";
const status: BridgeInFlightStatus = "SENT";
deriveBridgeStatus({ status });
const threshold: number = BRIDGE_STUCK_THRESHOLD_SECONDS[status];
void threshold;
// @ts-expect-error Unknown states must not widen the public status union.
const invalid: BridgeInFlightStatus = "UNKNOWN";
void invalid;
`,
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
        },
        files: ["index.mts"],
      }),
    );
    execFileSync(
      process.execPath,
      [compiler, "-p", join(consumer, "tsconfig.json")],
      { stdio: "pipe" },
    );
    const runtime = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { BRIDGE_STUCK_THRESHOLD_SECONDS } from "@mento-protocol/config/bridge-status"; console.log(BRIDGE_STUCK_THRESHOLD_SECONDS.SENT);',
      ],
      { cwd: consumer, encoding: "utf8" },
    );
    expect(runtime.trim()).toBe("3600");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
