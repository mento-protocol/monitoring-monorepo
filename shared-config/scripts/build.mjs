import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = require.resolve("typescript/bin/tsc");

rmSync(join(packageRoot, "dist"), { force: true, recursive: true });
execFileSync(process.execPath, [compiler], {
  cwd: packageRoot,
  stdio: "inherit",
});
