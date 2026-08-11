import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { endianness, homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  UPSTASH_MCP_RUNTIME_SHA256,
  UPSTASH_MCP_VERSION,
  verifyUpstashMcpEntrypoint,
} from "./upstash-mcp-launcher.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ESBUILD_VERSION = "0.28.1";
const ESBUILD_PACKAGE_JSON_SHA256 =
  "d55d1d19fcc5b6079e4a71dd4111340c79c682bc36835ac7058a0c364c7db58a";
const BUNDLE_FILENAME = `upstash-mcp-server-${UPSTASH_MCP_VERSION}-${UPSTASH_MCP_RUNTIME_SHA256}.mjs`;
const BUNDLE_BANNER =
  'import { createRequire } from "node:module"; const require = createRequire(process.execPath);';
const execFileAsync = promisify(execFile);
const ESBUILD_NATIVE_PACKAGES = {
  "aix ppc64 BE": ["@esbuild/aix-ppc64", "bin/esbuild"],
  "android arm64 LE": ["@esbuild/android-arm64", "bin/esbuild"],
  "darwin arm64 LE": ["@esbuild/darwin-arm64", "bin/esbuild"],
  "darwin x64 LE": ["@esbuild/darwin-x64", "bin/esbuild"],
  "freebsd arm64 LE": ["@esbuild/freebsd-arm64", "bin/esbuild"],
  "freebsd x64 LE": ["@esbuild/freebsd-x64", "bin/esbuild"],
  "linux arm LE": ["@esbuild/linux-arm", "bin/esbuild"],
  "linux arm64 LE": ["@esbuild/linux-arm64", "bin/esbuild"],
  "linux ia32 LE": ["@esbuild/linux-ia32", "bin/esbuild"],
  "linux loong64 LE": ["@esbuild/linux-loong64", "bin/esbuild"],
  "linux mips64el LE": ["@esbuild/linux-mips64el", "bin/esbuild"],
  "linux ppc64 LE": ["@esbuild/linux-ppc64", "bin/esbuild"],
  "linux riscv64 LE": ["@esbuild/linux-riscv64", "bin/esbuild"],
  "linux s390x BE": ["@esbuild/linux-s390x", "bin/esbuild"],
  "linux x64 LE": ["@esbuild/linux-x64", "bin/esbuild"],
  "netbsd arm64 LE": ["@esbuild/netbsd-arm64", "bin/esbuild"],
  "netbsd x64 LE": ["@esbuild/netbsd-x64", "bin/esbuild"],
  "openbsd arm64 LE": ["@esbuild/openbsd-arm64", "bin/esbuild"],
  "openbsd x64 LE": ["@esbuild/openbsd-x64", "bin/esbuild"],
  "sunos x64 LE": ["@esbuild/sunos-x64", "bin/esbuild"],
  "win32 arm64 LE": ["@esbuild/win32-arm64", "esbuild.exe"],
  "win32 ia32 LE": ["@esbuild/win32-ia32", "esbuild.exe"],
  "win32 x64 LE": ["@esbuild/win32-x64", "esbuild.exe"],
};
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

export async function verifyEsbuildBinary({
  repoRoot = ROOT,
  platform = process.platform,
  architecture = process.arch,
  byteOrder = endianness(),
} = {}) {
  const platformKey = `${platform} ${architecture} ${byteOrder}`;
  const platformPackage = ESBUILD_NATIVE_PACKAGES[platformKey];
  if (!platformPackage) {
    throw new Error(`unsupported reviewed esbuild platform: ${platformKey}`);
  }

  const packageJsonPath = await realpath(
    resolve(repoRoot, "node_modules/esbuild/package.json"),
  );
  const packageJsonBytes = await readFile(packageJsonPath);
  if (sha256(packageJsonBytes) !== ESBUILD_PACKAGE_JSON_SHA256) {
    throw new Error(
      "the esbuild package manifest does not match the reviewed artifact",
    );
  }
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  if (
    packageJson.name !== "esbuild" ||
    packageJson.version !== ESBUILD_VERSION
  ) {
    throw new Error(`expected esbuild ${ESBUILD_VERSION}`);
  }

  const [packageName, subpath] = platformPackage;
  const binaryKey = `${packageName}/${subpath}`;
  const expectedSha256 = packageJson["esbuild.binaryHashes"]?.[binaryKey];
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) {
    throw new Error(`the reviewed esbuild manifest omits ${binaryKey}`);
  }
  const packageRequire = createRequire(packageJsonPath);
  const sourcePath = await realpath(packageRequire.resolve(binaryKey));
  const bytes = await readFile(sourcePath);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(
      "the esbuild native binary does not match the reviewed artifact",
    );
  }

  return {
    binaryName: basename(subpath),
    bytes,
    expectedSha256,
    packageName,
    sourcePath,
    subpath,
  };
}

async function runVerifiedEsbuild({ entrypointFromRoot, repoRoot }) {
  const verifiedBinary = await verifyEsbuildBinary({ repoRoot });
  const privateDirectory = await mkdtemp(
    resolve(tmpdir(), "upstash-esbuild-snapshot-"),
  );
  const binaryPath = resolve(privateDirectory, verifiedBinary.binaryName);
  const outputPath = resolve(privateDirectory, "upstash-mcp-runtime.mjs");
  const metafilePath = resolve(privateDirectory, "upstash-mcp-metafile.json");
  let binaryHandle;

  try {
    if (process.platform !== "win32") await chmod(privateDirectory, 0o700);
    binaryHandle = await open(binaryPath, "wx", 0o700);
    await binaryHandle.writeFile(verifiedBinary.bytes);
    await binaryHandle.sync();
    await binaryHandle.close();
    binaryHandle = undefined;

    await execFileAsync(
      binaryPath,
      [
        entrypointFromRoot,
        "--bundle",
        `--banner:js=${BUNDLE_BANNER}`,
        "--format=esm",
        "--legal-comments=eof",
        "--log-level=silent",
        `--metafile=${metafilePath}`,
        `--outfile=${outputPath}`,
        "--platform=node",
        "--target=node22",
      ],
      {
        cwd: repoRoot,
        env: {},
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    const [bytes, metafileSource] = await Promise.all([
      readFile(outputPath),
      readFile(metafilePath, "utf8"),
    ]);
    return { bytes, metafile: JSON.parse(metafileSource) };
  } finally {
    await binaryHandle?.close();
    await rm(privateDirectory, { force: true, recursive: true });
  }
}

export async function buildUpstashMcpRuntime({ repoRoot = ROOT } = {}) {
  const { entrypoint } = verifyUpstashMcpEntrypoint({ repoRoot });
  const entrypointFromRoot = relative(repoRoot, entrypoint);
  if (
    entrypointFromRoot === ".." ||
    entrypointFromRoot.startsWith("../") ||
    isAbsolute(entrypointFromRoot)
  ) {
    throw new Error("the Upstash MCP entrypoint escapes the repository");
  }

  const result = await runVerifiedEsbuild({ entrypointFromRoot, repoRoot });
  if (Object.keys(result.metafile.outputs).length !== 1) {
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

  const bytes = result.bytes;
  return {
    bytes,
    externalImports: [...new Set(externalImports)].sort(),
    inputs,
    sha256: sha256(bytes),
  };
}

async function publishRuntimeAtomically({ runtimePath, bytes }) {
  const temporaryPath = `${runtimePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o400);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, runtimePath);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
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

  const published = await publishRuntimeAtomically({
    bytes: runtime.bytes,
    runtimePath,
  });
  if (!published) return verifyExistingRuntime(runtimePath);
  return verifyExistingRuntime(runtimePath);
}
