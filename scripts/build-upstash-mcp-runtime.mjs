import { createHash } from "node:crypto";
import { open, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";
import {
  UPSTASH_MCP_RUNTIME_SHA256,
  UPSTASH_MCP_VERSION,
  verifyUpstashMcpEntrypoint,
} from "./upstash-mcp-launcher.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ESBUILD_VERSION = "0.28.1";
const BUNDLE_FILENAME = `upstash-mcp-server-${UPSTASH_MCP_VERSION}-${UPSTASH_MCP_RUNTIME_SHA256}.mjs`;
const BUNDLE_BANNER =
  'import { createRequire } from "node:module"; const require = createRequire(process.execPath);';
const REQUIRED_RUNTIME_INPUTS = [
  "@modelcontextprotocol+sdk@",
  "@upstash+mcp-server@0.2.4",
  "commander@14.0.3",
  "dotenv@16.6.1",
  "zod@3.25.76",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNodeBuiltin(specifier) {
  const normalized = specifier.startsWith("node:")
    ? specifier.slice("node:".length)
    : specifier;
  return builtinModules.includes(normalized);
}

export async function buildUpstashMcpRuntime({ repoRoot = ROOT } = {}) {
  if (esbuildVersion !== ESBUILD_VERSION) {
    throw new Error(`expected esbuild ${ESBUILD_VERSION}`);
  }

  const { entrypoint } = verifyUpstashMcpEntrypoint({ repoRoot });
  const entrypointFromRoot = relative(repoRoot, entrypoint);
  if (
    entrypointFromRoot === ".." ||
    entrypointFromRoot.startsWith("../") ||
    isAbsolute(entrypointFromRoot)
  ) {
    throw new Error("the Upstash MCP entrypoint escapes the repository");
  }

  const result = await build({
    absWorkingDir: repoRoot,
    banner: { js: BUNDLE_BANNER },
    bundle: true,
    entryPoints: [entrypointFromRoot],
    format: "esm",
    legalComments: "eof",
    logLevel: "silent",
    metafile: true,
    outfile: "upstash-mcp-runtime.mjs",
    platform: "node",
    sourcemap: false,
    target: ["node22"],
    write: false,
  });
  if (result.outputFiles.length !== 1) {
    throw new Error("expected one dependency-closed Upstash MCP runtime");
  }

  const inputs = Object.keys(result.metafile.inputs).sort();
  for (const requiredInput of REQUIRED_RUNTIME_INPUTS) {
    if (!inputs.some((input) => input.includes(requiredInput))) {
      throw new Error(`the Upstash runtime omits ${requiredInput}`);
    }
  }
  const externalImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((input) => input.external)
    .map((input) => input.path);
  const nonBuiltinImports = externalImports.filter(
    (specifier) => !isNodeBuiltin(specifier),
  );
  if (nonBuiltinImports.length > 0) {
    throw new Error(
      `the Upstash runtime retains external packages: ${nonBuiltinImports.join(", ")}`,
    );
  }

  const bytes = result.outputFiles[0].contents;
  return {
    bytes,
    externalImports: [...new Set(externalImports)].sort(),
    inputs,
    sha256: sha256(bytes),
  };
}

async function verifyExistingRuntime(runtimePath) {
  const [bytes, metadata] = await Promise.all([
    readFile(runtimePath),
    stat(runtimePath),
  ]);
  if (!metadata.isFile() || sha256(bytes) !== UPSTASH_MCP_RUNTIME_SHA256) {
    throw new Error(
      "the personal Upstash MCP runtime does not match the reviewed bundle",
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("the personal Upstash MCP runtime is not private");
  }
  return realpath(runtimePath);
}

export async function prepareUpstashMcpRuntime({
  repoRoot = ROOT,
  runtimeDirectory = resolve(homedir(), ".codex", "mcp-runtimes"),
} = {}) {
  if (!isAbsolute(runtimeDirectory)) {
    throw new Error("the personal MCP runtime directory must be absolute");
  }
  const runtime = await buildUpstashMcpRuntime({ repoRoot });
  if (runtime.sha256 !== UPSTASH_MCP_RUNTIME_SHA256) {
    throw new Error(
      "the dependency-closed Upstash MCP runtime does not match the reviewed bundle",
    );
  }

  await mkdir(runtimeDirectory, { mode: 0o700, recursive: true });
  const runtimePath = resolve(runtimeDirectory, BUNDLE_FILENAME);
  try {
    return await verifyExistingRuntime(runtimePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let handle;
  try {
    handle = await open(runtimePath, "wx", 0o400);
    await handle.writeFile(runtime.bytes);
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") return verifyExistingRuntime(runtimePath);
    throw error;
  } finally {
    await handle?.close();
  }
  return verifyExistingRuntime(runtimePath);
}
