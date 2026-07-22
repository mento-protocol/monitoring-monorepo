#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./agent-autoreview.mjs", import.meta.url),
);
const wrapper = fileURLToPath(
  new URL("./agent-autoreview.sh", import.meta.url),
);
const fixtureParent = process.env.AUTOREVIEW_TEST_TRUSTED_FIXTURE_PARENT;
assert.ok(
  fixtureParent,
  "AUTOREVIEW_TEST_TRUSTED_FIXTURE_PARENT must name the suite's private fixture directory",
);
const root = mkdtempSync(
  path.join(fixtureParent, "agent-autoreview-target-guard."),
);
const repo = path.join(root, "repo");
const bin = path.join(root, "bin");
const claude = path.join(bin, "claude");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function sha256File(candidate) {
  return createHash("sha256").update(readFileSync(candidate)).digest("hex");
}

function createNodeFixture(
  directory,
  { uid = 65534, gid = uid, mode = 0o777 } = {},
) {
  const executable = path.join(directory, "node");
  mkdirSync(directory);
  chmodSync(directory, 0o700);
  copyFileSync(process.execPath, executable);
  chownSync(executable, uid, gid);
  chmodSync(executable, mode);
  assert.equal(lstatSync(executable, { bigint: true }).uid, BigInt(uid));
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    version.status,
    0,
    `foreign-owned Node fixture is not runnable: ${version.stderr}`,
  );
  return executable;
}

function createForeignNodeFixture(directory) {
  return createNodeFixture(directory);
}

function assertSealedNodeSnapshot(marker, sourceNode) {
  const metadata = JSON.parse(readFileSync(marker, "utf8"));
  const sourceStat = lstatSync(sourceNode, { bigint: true });
  assert.ok(path.isAbsolute(metadata.executable));
  assert.notEqual(metadata.executable, sourceNode);
  assert.notEqual(
    `${metadata.dev}:${metadata.ino}`,
    `${sourceStat.dev}:${sourceStat.ino}`,
    "semantic engine executed the foreign-owned Node inode directly",
  );
  assert.equal(metadata.uid, "0");
  assert.equal(metadata.mode, "500");
  assert.equal(metadata.nlink, "1");
  assert.equal(metadata.parentUid, "0");
  assert.equal(metadata.parentMode, "700");
  assert.equal(metadata.sha256, sha256File(sourceNode));
  assert.ok(path.isAbsolute(metadata.nodeLibraryPath));
  assert.equal(
    path.dirname(metadata.nodeLibraryPath),
    path.dirname(metadata.executable),
  );
  assert.equal(metadata.nodeLibraryUid, "0");
  assert.equal(metadata.nodeLibraryMode, "700");
  assert.ok(metadata.nodeLibraryAliases > 0);
  assert.equal(
    metadata.snapshotDiagnostics,
    "",
    "test-only root trust diagnostics leaked into the semantic engine",
  );
  assert.ok(
    metadata.executable !== repo &&
      !metadata.executable.startsWith(`${repo}${path.sep}`),
    "semantic engine Node snapshot was published inside the reviewed repo",
  );
}

function extractStrictElfMetadataProgram() {
  const source = readFileSync(wrapper, "utf8");
  const functionOffset = source.indexOf("strict_linux_elf_metadata() {");
  const programMarker = "system_perl -MConfig -MFcntl=:DEFAULT,:mode -e '\n";
  const programOffset = source.indexOf(programMarker, functionOffset);
  const endMarker = '\n  \' "$candidate" "$interpreter_policy"\n}';
  const endOffset = source.indexOf(endMarker, programOffset);
  assert.ok(functionOffset >= 0, "strict ELF metadata function is missing");
  assert.ok(programOffset >= 0, "strict ELF metadata program is missing");
  assert.ok(
    endOffset > programOffset,
    "strict ELF metadata program is malformed",
  );
  return source.slice(programOffset + programMarker.length, endOffset);
}

function extractStrictLoaderListMetadataProgram() {
  const source = readFileSync(wrapper, "utf8");
  const functionOffset = source.indexOf(
    "strict_linux_loader_list_metadata() {",
  );
  const programMarker =
    "system_perl -MDigest::SHA -MFcntl=:DEFAULT,:mode -e '\n";
  const programOffset = source.indexOf(programMarker, functionOffset);
  const endMarker = '\n  \' "$output" "$resolved_interpreter" "$EUID" "$@"\n}';
  const endOffset = source.indexOf(endMarker, programOffset);
  assert.ok(
    functionOffset >= 0,
    "strict loader-list metadata function is missing",
  );
  assert.ok(
    programOffset >= 0,
    "strict loader-list metadata program is missing",
  );
  assert.ok(
    endOffset > programOffset,
    "strict loader-list metadata program is malformed",
  );
  return source.slice(programOffset + programMarker.length, endOffset);
}

function assertStrictLoaderListMetadataWiring() {
  const lines = readFileSync(wrapper, "utf8").split("\n");
  const calls = lines.flatMap((line, index) =>
    line.trim() === "strict_linux_loader_list_metadata \\"
      ? [lines.slice(index, index + 4)]
      : [],
  );
  assert.equal(
    calls.length,
    3,
    "every loader-list metadata call must share the strict needed-name policy",
  );
  for (const call of calls) {
    assert.equal(
      call[3]?.trim(),
      '"${needed_names[@]+"${needed_names[@]}"}"',
      "loader-list metadata call omitted the collected DT_NEEDED names",
    );
  }
}

function assertLoaderFingerprintPrecedesExecution() {
  const source = readFileSync(wrapper, "utf8");
  const functionOffset = source.indexOf(
    "linux_node_snapshot_closure_is_trusted() {",
  );
  const endOffset = source.indexOf(
    "linux_node_snapshot_has_safe_closure() {",
    functionOffset,
  );
  assert.ok(functionOffset >= 0 && endOffset > functionOffset);
  const closure = source.slice(functionOffset, endOffset);
  const fingerprintOffset = closure.indexOf(
    '"$current" == "${record_resolved[$index]}"',
  );
  const executionOffset = closure.indexOf(
    'strict_linux_glibc_loader_is_supported "$loader_resolved"',
  );
  assert.ok(
    fingerprintOffset >= 0,
    "loader closure re-attestation must compare sealed fingerprints",
  );
  assert.ok(
    executionOffset > fingerprintOffset,
    "loader closure re-attestation executed the loader before fingerprint validation",
  );
}

function assertHelperBindsSealedLoaderFingerprint() {
  const source = readFileSync(script, "utf8");
  const manifestOffset = source.indexOf(
    "function inspectAttestedNodeManifest(",
  );
  const endOffset = source.indexOf(
    "function sameAttestedNodeManifest(",
    manifestOffset,
  );
  assert.ok(manifestOffset >= 0 && endOffset > manifestOffset);
  const manifestInspection = source.slice(manifestOffset, endOffset);
  const fingerprintOffset = manifestInspection.indexOf(
    "linuxLoaderPathFingerprint(loaderRequested, repo)",
  );
  const comparisonOffset = manifestInspection.indexOf(
    "loader.fingerprint !== loaderFingerprint",
  );
  assert.ok(
    fingerprintOffset >= 0 && comparisonOffset > fingerprintOffset,
    "helper must bind the live loader path/content fingerprint to the sealed manifest",
  );
}

function writeUnsigned(buffer, offset, bytes, value, littleEndian) {
  const integer = BigInt(value);
  if (bytes === 2) {
    buffer[littleEndian ? "writeUInt16LE" : "writeUInt16BE"](
      Number(integer),
      offset,
    );
  } else if (bytes === 4) {
    buffer[littleEndian ? "writeUInt32LE" : "writeUInt32BE"](
      Number(integer),
      offset,
    );
  } else {
    buffer[littleEndian ? "writeBigUInt64LE" : "writeBigUInt64BE"](
      integer,
      offset,
    );
  }
}

function syntheticElf({
  dynamicEntries,
  elf64 = true,
  extraInterpreter = false,
  extraLoad = false,
  interpreter,
  littleEndian = true,
  strings = Buffer.from("\0libc.so.6\0fixture.so\0", "latin1"),
  withInterpreter = true,
} = {}) {
  const size = 1024;
  const buffer = Buffer.alloc(size);
  const headerSize = elf64 ? 64 : 52;
  const programHeaderSize = elf64 ? 56 : 32;
  const programHeaderOffset = 64;
  const interpreterOffset = 384;
  const dynamicOffset = 512;
  const stringOffset = 768;
  const virtualBase = elf64 ? 0x40_0000n : 0x0804_8000n;
  const entries = dynamicEntries || [
    [5n, virtualBase + BigInt(stringOffset)],
    [10n, BigInt(strings.length)],
    [1n, 1n],
    [14n, 11n],
    [0n, 0n],
  ];
  const dynamicEntrySize = elf64 ? 16 : 8;
  const dynamicSize = entries.length * dynamicEntrySize;
  const interpreterBytes = Buffer.from(
    interpreter ||
      (elf64 ? "/lib64/ld-linux-x86-64.so.2\0" : "/lib/ld-linux.so.2\0"),
    "latin1",
  );
  const programHeaderCount =
    2 + Number(withInterpreter) + Number(extraInterpreter) + Number(extraLoad);
  assert.ok(
    programHeaderOffset + programHeaderCount * programHeaderSize <=
      interpreterOffset,
    "synthetic ELF program headers overlap the interpreter payload",
  );
  assert.ok(
    interpreterOffset + interpreterBytes.length <= dynamicOffset,
    "synthetic ELF interpreter payload overlaps the dynamic table",
  );
  buffer.set([0x7f, 0x45, 0x4c, 0x46, elf64 ? 2 : 1, littleEndian ? 1 : 2, 1]);
  writeUnsigned(buffer, 16, 2, 3, littleEndian);
  writeUnsigned(buffer, 20, 4, 1, littleEndian);
  writeUnsigned(
    buffer,
    elf64 ? 32 : 28,
    elf64 ? 8 : 4,
    programHeaderOffset,
    littleEndian,
  );
  writeUnsigned(buffer, elf64 ? 52 : 40, 2, headerSize, littleEndian);
  writeUnsigned(buffer, elf64 ? 54 : 42, 2, programHeaderSize, littleEndian);
  writeUnsigned(buffer, elf64 ? 56 : 44, 2, programHeaderCount, littleEndian);

  const writeProgramHeader = (
    index,
    type,
    fileOffset,
    virtualAddress,
    fileSize,
    memorySize = fileSize,
  ) => {
    const base = programHeaderOffset + index * programHeaderSize;
    writeUnsigned(buffer, base, 4, type, littleEndian);
    writeUnsigned(
      buffer,
      base + (elf64 ? 8 : 4),
      elf64 ? 8 : 4,
      fileOffset,
      littleEndian,
    );
    writeUnsigned(
      buffer,
      base + (elf64 ? 16 : 8),
      elf64 ? 8 : 4,
      virtualAddress,
      littleEndian,
    );
    writeUnsigned(
      buffer,
      base + (elf64 ? 32 : 16),
      elf64 ? 8 : 4,
      fileSize,
      littleEndian,
    );
    writeUnsigned(
      buffer,
      base + (elf64 ? 40 : 20),
      elf64 ? 8 : 4,
      memorySize,
      littleEndian,
    );
  };
  writeProgramHeader(0, 1, 0, virtualBase, size);
  writeProgramHeader(
    1,
    2,
    dynamicOffset,
    virtualBase + BigInt(dynamicOffset),
    dynamicSize,
  );
  let nextProgramHeader = 2;
  if (withInterpreter) {
    writeProgramHeader(
      nextProgramHeader,
      3,
      interpreterOffset,
      virtualBase + BigInt(interpreterOffset),
      interpreterBytes.length,
    );
    nextProgramHeader += 1;
    buffer.set(interpreterBytes, interpreterOffset);
  }
  if (extraInterpreter) {
    writeProgramHeader(
      nextProgramHeader,
      3,
      interpreterOffset,
      virtualBase + BigInt(interpreterOffset),
      interpreterBytes.length,
    );
    nextProgramHeader += 1;
  }
  if (extraLoad) {
    writeProgramHeader(nextProgramHeader, 1, 0, virtualBase, size);
  }
  entries.forEach(([tag, value], index) => {
    const offset = dynamicOffset + index * dynamicEntrySize;
    writeUnsigned(buffer, offset, elf64 ? 8 : 4, tag, littleEndian);
    writeUnsigned(
      buffer,
      offset + (elf64 ? 8 : 4),
      elf64 ? 8 : 4,
      value,
      littleEndian,
    );
  });
  buffer.set(strings, stringOffset);
  return {
    buffer,
    dynamicOffset,
    programHeaderOffset,
    programHeaderSize,
    virtualBase,
  };
}

function runStrictElfMetadata(fixture, interpreterPolicy) {
  const perl = ["/usr/bin/perl", "/bin/perl"].find((candidate) =>
    existsSync(candidate),
  );
  assert.ok(perl, "strict ELF metadata tests require system Perl");
  const candidate = path.join(
    root,
    "strict-elf-" + runStrictElfMetadata.sequence++ + ".bin",
  );
  writeFileSync(candidate, fixture.buffer);
  return spawnSync(
    perl,
    [
      "-MConfig",
      "-MFcntl=:DEFAULT,:mode",
      "-e",
      extractStrictElfMetadataProgram(),
      candidate,
      interpreterPolicy,
    ],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
runStrictElfMetadata.sequence = 0;

function assertStrictElfAccepted(fixture, interpreterPolicy = "required") {
  const result = runStrictElfMetadata(fixture, interpreterPolicy);
  assert.equal(
    result.status,
    0,
    "strict ELF parser rejected a valid fixture: " + result.stderr,
  );
  return result.stdout;
}

function assertStrictElfRejected(fixture, interpreterPolicy = "required") {
  const result = runStrictElfMetadata(fixture, interpreterPolicy);
  assert.notEqual(
    result.status,
    0,
    "strict ELF parser accepted unsafe metadata",
  );
}

function exerciseStrictElfMetadataParser() {
  for (const elf64 of [false, true]) {
    for (const littleEndian of [false, true]) {
      assert.match(
        assertStrictElfAccepted(syntheticElf({ elf64, littleEndian })),
        /interpreter\t\/lib(?:64)?\/ld-linux/,
      );
      assertStrictElfAccepted(
        syntheticElf({ elf64, littleEndian, withInterpreter: false }),
        "forbidden",
      );
      assert.match(
        assertStrictElfAccepted(
          syntheticElf({ elf64, littleEndian }),
          "optional",
        ),
        /interpreter\t\/lib(?:64)?\/ld-linux/,
      );
      assertStrictElfAccepted(
        syntheticElf({ elf64, littleEndian, withInterpreter: false }),
        "optional",
      );
    }
  }
  assertStrictElfRejected(syntheticElf({ withInterpreter: false }));
  assertStrictElfRejected(syntheticElf(), "forbidden");
  assertStrictElfRejected(syntheticElf({ extraInterpreter: true }), "optional");
  assertStrictElfRejected(syntheticElf(), "invalid");
  assertStrictElfRejected(syntheticElf({ extraLoad: true }));
  assertStrictElfRejected(syntheticElf({ interpreter: "relative/ld.so\0" }));
  assertStrictElfRejected(
    syntheticElf({ interpreter: "/lib/ld.so\0hidden\0" }),
  );

  const dynamicAddressMismatch = syntheticElf();
  writeUnsigned(
    dynamicAddressMismatch.buffer,
    dynamicAddressMismatch.programHeaderOffset +
      dynamicAddressMismatch.programHeaderSize +
      16,
    8,
    dynamicAddressMismatch.virtualBase + 640n,
    true,
  );
  assertStrictElfRejected(dynamicAddressMismatch);

  const dynamicMemoryMismatch = syntheticElf();
  writeUnsigned(
    dynamicMemoryMismatch.buffer,
    dynamicMemoryMismatch.programHeaderOffset +
      dynamicMemoryMismatch.programHeaderSize +
      40,
    8,
    96,
    true,
  );
  assertStrictElfRejected(dynamicMemoryMismatch);

  for (const forbiddenTag of [
    0xfn,
    0x1dn,
    0x6ffffefan,
    0x6ffffefbn,
    0x6ffffefcn,
    0x7ffffffdn,
    0x7fffffffn,
  ]) {
    assertStrictElfRejected(
      syntheticElf({
        dynamicEntries: [
          [5n, 0x40_0300n],
          [10n, 23n],
          [1n, 1n],
          [forbiddenTag, 11n],
          [0n, 0n],
        ],
      }),
    );
  }
  for (const dynamicEntries of [
    [
      [5n, 0x40_0300n],
      [10n, 23n],
      [1n, 1n],
    ],
    [
      [5n, 0x40_0300n],
      [10n, 23n],
      [0n, 0n],
      [1n, 1n],
    ],
    [
      [5n, 0x40_0300n],
      [5n, 0x40_0300n],
      [10n, 23n],
      [0n, 0n],
    ],
    [
      [5n, 0x40_0300n],
      [10n, 23n],
      [10n, 23n],
      [0n, 0n],
    ],
    [
      [5n, 0x40_0300n],
      [10n, 23n],
      [1n, 1n],
      [1n, 1n],
      [0n, 0n],
    ],
    [
      [5n, 0x40_0300n],
      [10n, 23n],
      [14n, 11n],
      [14n, 11n],
      [0n, 0n],
    ],
  ]) {
    assertStrictElfRejected(syntheticElf({ dynamicEntries }));
  }
  assertStrictElfRejected(
    syntheticElf({
      strings: Buffer.from("\0bad/name\0", "latin1"),
      dynamicEntries: [
        [5n, 0x40_0300n],
        [10n, 10n],
        [1n, 1n],
        [0n, 0n],
      ],
    }),
  );
  assertStrictElfRejected(
    syntheticElf({
      strings: Buffer.from("\0unterminated", "latin1"),
      dynamicEntries: [
        [5n, 0x40_0300n],
        [10n, 13n],
        [1n, 1n],
        [0n, 0n],
      ],
    }),
  );
}

function exerciseStrictLoaderListMetadataParser() {
  const perl = ["/usr/bin/perl", "/bin/perl"].find((candidate) =>
    existsSync(candidate),
  );
  assert.ok(perl, "strict loader-list tests require system Perl");
  const output = path.join(root, "strict-loader-list.out");
  const interpreterAlias = path.join(root, "ld-fixture.so.2");
  symlinkSync(process.execPath, interpreterAlias);
  writeFileSync(
    output,
    `${interpreterAlias} (0x7f0000000000)\nlibfixture.so.1 => ${process.execPath} (0x7f0000001000)\n`,
  );
  const run = (...neededNames) =>
    spawnSync(
      perl,
      [
        "-MDigest::SHA",
        "-MFcntl=:DEFAULT,:mode",
        "-e",
        extractStrictLoaderListMetadataProgram(),
        output,
        process.execPath,
        String(process.geteuid?.() ?? process.getuid()),
        ...neededNames,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  const interpreterName = path.basename(interpreterAlias);
  const accepted = run(interpreterName, "libfixture.so.1");
  assert.equal(
    accepted.status,
    0,
    `strict loader-list parser rejected an inode-matched DT_NEEDED interpreter: ${accepted.stderr}`,
  );
  assert.match(accepted.stdout, /^standalone\t/mu);
  assert.ok(
    accepted.stdout.includes(
      `interpreter\t${interpreterName}\t${interpreterAlias}\n`,
    ),
    "strict loader-list parser did not expose the inode-matched standalone path",
  );
  const canonicalBasename = run(path.basename(process.execPath));
  assert.notEqual(
    canonicalBasename.status,
    0,
    "strict loader-list parser used the resolved interpreter basename instead of the matched output path",
  );
  const rejected = run("libmissing.so.1");
  assert.notEqual(
    rejected.status,
    0,
    "strict loader-list parser accepted a missing non-interpreter dependency",
  );
}

try {
  exerciseStrictElfMetadataParser();
  assertStrictLoaderListMetadataWiring();
  assertLoaderFingerprintPrecedesExecution();
  assertHelperBindsSealedLoaderFingerprint();
  exerciseStrictLoaderListMetadataParser();
  mkdirSync(repo);
  mkdirSync(bin);
  git(["init", "-q"]);
  git(["config", "user.email", "autoreview-test@example.com"]);
  git(["config", "user.name", "Autoreview Test"]);
  writeFileSync(path.join(repo, "reviewed.txt"), "base\n");
  git(["add", "reviewed.txt"]);
  git(["commit", "-q", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(repo, "reviewed.txt"), "base\nreviewed change\n");
  git(["add", "reviewed.txt"]);
  git(["commit", "-q", "-m", "change"]);
  const head = git(["rev-parse", "HEAD"]);
  const reviewArgs = [
    script,
    "--mode",
    "branch",
    "--base",
    base,
    "--engine",
    "claude",
    "--no-tools",
    "--frozen-target-mode",
    "branch",
    "--frozen-head-oid",
    head,
  ];

  writeFileSync(
    claude,
    `#!/bin/sh
case "\${1:-}" in
  --version)
    printf '%s\\n' '2.1.169'
    exit 0
    ;;
  --help)
    printf '%s\\n' '--safe-mode --setting-sources --strict-mcp-config --disallowedTools --tools'
    exit 0
    ;;
esac
cat >/dev/null
if [ -n "\${AUTOREVIEW_FAKE_NODE_MARKER:-}" ]; then
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const executable = fs.realpathSync(process.execPath);
    const stat = fs.lstatSync(executable, { bigint: true });
    const parentStat = fs.lstatSync(path.dirname(executable), { bigint: true });
    const nodeLibraryPath = fs.realpathSync(process.env.LD_LIBRARY_PATH);
    const nodeLibraryStat = fs.lstatSync(nodeLibraryPath, { bigint: true });
    fs.writeFileSync(
      process.env.AUTOREVIEW_FAKE_NODE_MARKER,
      JSON.stringify({
        executable,
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        uid: stat.uid.toString(),
        mode: Number(stat.mode & 0o7777n).toString(8),
        nlink: stat.nlink.toString(),
        parentUid: parentStat.uid.toString(),
        parentMode: Number(parentStat.mode & 0o7777n).toString(8),
        sha256: crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex"),
        nodeLibraryPath,
        nodeLibraryUid: nodeLibraryStat.uid.toString(),
        nodeLibraryMode: Number(nodeLibraryStat.mode & 0o7777n).toString(8),
        nodeLibraryAliases: fs.readdirSync(nodeLibraryPath).length,
        snapshotDiagnostics: process.env.AUTOREVIEW_TEST_NODE_SNAPSHOT_DIAGNOSTICS || "",
      }) + "\\n",
    );
    if (process.env.AUTOREVIEW_FAKE_ALIAS_TAMPER) {
      const aliasPath = path.join(
        nodeLibraryPath,
        fs.readdirSync(nodeLibraryPath).sort()[0],
      );
      const target = fs.readlinkSync(aliasPath);
      fs.unlinkSync(aliasPath);
      fs.symlinkSync(target, aliasPath);
    }
    if (process.env.AUTOREVIEW_FAKE_SNAPSHOT_MODE_TAMPER) {
      fs.chmodSync(executable, 0o700);
    }
    if (process.env.AUTOREVIEW_FAKE_MANIFEST_TAMPER) {
      const manifestPrefix = path.basename(executable) + ".loader-closure.";
      const manifestName = fs
        .readdirSync(path.dirname(executable))
        .find((name) => name.startsWith(manifestPrefix));
      if (!manifestName) throw new Error("attested Node manifest is missing");
      const manifestPath = path.join(path.dirname(executable), manifestName);
      fs.chmodSync(manifestPath, 0o600);
      fs.appendFileSync(manifestPath, "tamper\\n");
      fs.chmodSync(manifestPath, 0o400);
    }
  '
fi
printf '%s\\n' 'unrelated local churn' >"$AUTOREVIEW_FAKE_MUTATE_REPO/unrelated.tmp"
printf '%s\\n' '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"fixture review","overall_confidence":1}'
`,
  );
  chmodSync(claude, 0o755);

  const currentNode = realpathSync(process.execPath);
  const currentNodeStat = lstatSync(currentNode, { bigint: true });
  const requireCurrentNodeSnapshot =
    process.env.AUTOREVIEW_TEST_REQUIRE_ROOT_SNAPSHOT === "1";
  const rootSnapshotCurrentNode =
    process.platform === "linux" &&
    process.geteuid?.() === 0 &&
    (currentNodeStat.uid !== 0n || requireCurrentNodeSnapshot);
  const inheritedNodeMarker = path.join(root, "inherited-node-snapshot.json");
  const reviewCommand = rootSnapshotCurrentNode ? wrapper : process.execPath;
  const reviewCommandArgs = rootSnapshotCurrentNode
    ? reviewArgs.slice(1)
    : reviewArgs;
  const result = spawnSync(reviewCommand, reviewCommandArgs, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      AUTOREVIEW_FAKE_MUTATE_REPO: repo,
      ...(rootSnapshotCurrentNode
        ? { AUTOREVIEW_FAKE_NODE_MARKER: inheritedNodeMarker }
        : {}),
      PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(
    result.status,
    0,
    `explicit frozen branch review rejected unrelated local churn:\n${result.stderr || result.stdout}`,
  );
  assert.match(
    result.stdout,
    /autoreview clean: no accepted\/actionable findings reported/,
  );
  if (rootSnapshotCurrentNode) {
    assertSealedNodeSnapshot(inheritedNodeMarker, currentNode);
  }

  if (process.platform === "linux" && process.geteuid?.() === 0) {
    const foreignNodeDir = path.join(root, "foreign-node-bin");
    const foreignNode = createForeignNodeFixture(foreignNodeDir);
    linkSync(foreignNode, path.join(root, "foreign-node-hardlink"));
    assert.equal(
      lstatSync(foreignNode, { bigint: true }).nlink,
      2n,
      "root regression requires a writable, hard-linked toolcache Node source",
    );
    const gitOnlyDir = path.join(root, "git-only-bin");
    mkdirSync(gitOnlyDir);
    assert.ok(
      existsSync("/usr/bin/git"),
      "root regression requires system Git",
    );
    symlinkSync("/usr/bin/git", path.join(gitOnlyDir, "git"));
    const rootOnlyPath = [bin, gitOnlyDir, foreignNodeDir].join(path.delimiter);

    const directForeignNode = spawnSync(foreignNode, reviewArgs, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTOREVIEW_FAKE_MUTATE_REPO: repo,
        PATH: rootOnlyPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(
      directForeignNode.status,
      0,
      "direct helper invocation must not attest its foreign-owned current Node",
    );
    assert.match(
      directForeignNode.stderr,
      /node runtime is not available outside the reviewed repo/,
    );

    const unmatchedForeignNodeDir = path.join(
      root,
      "unmatched-foreign-node-bin",
    );
    createForeignNodeFixture(unmatchedForeignNodeDir);
    const unmatchedNode = spawnSync(wrapper, reviewArgs.slice(1), {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTOREVIEW_FAKE_MUTATE_REPO: repo,
        PATH: [bin, gitOnlyDir, unmatchedForeignNodeDir].join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(
      unmatchedNode.status,
      0,
      "canonical wrapper must reject an unmatched foreign-owned PATH Node",
    );
    assert.match(unmatchedNode.stderr, /requires a trusted node executable/);

    const launcher = path.join(root, "node-ancestor-launcher.cjs");
    const wrapperMarker = path.join(root, "wrapper-node-snapshot.json");
    writeFileSync(
      launcher,
      `const { spawnSync } = require("node:child_process");
if (typeof process.geteuid !== "function" || process.geteuid() !== 0) {
  throw new Error("matched Node ancestor fixture must run as root");
}
const result = spawnSync(process.argv[2], process.argv.slice(3), {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`,
    );
    const reviewThroughAncestor = (
      nodeExecutable,
      nodePath,
      marker,
      extraEnv = {},
    ) =>
      spawnSync(nodeExecutable, [launcher, wrapper, ...reviewArgs.slice(1)], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          AUTOREVIEW_FAKE_MUTATE_REPO: repo,
          AUTOREVIEW_FAKE_NODE_MARKER: marker,
          PATH: nodePath,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    const wrapperReview = reviewThroughAncestor(
      foreignNode,
      rootOnlyPath,
      wrapperMarker,
    );
    assert.equal(
      wrapperReview.status,
      0,
      `canonical wrapper rejected its foreign-owned Node ancestor:\n${wrapperReview.stderr || wrapperReview.stdout}`,
    );
    assert.match(
      wrapperReview.stdout,
      /autoreview clean: no accepted\/actionable findings reported/,
    );
    assertSealedNodeSnapshot(wrapperMarker, foreignNode);

    const rootOwnedNodeDir = path.join(root, "root-owned-node-bin");
    const rootOwnedNode = createNodeFixture(rootOwnedNodeDir, {
      uid: 0,
      gid: 0,
      mode: 0o777,
    });
    linkSync(rootOwnedNode, path.join(root, "root-owned-node-hardlink"));
    assert.equal(
      lstatSync(rootOwnedNode, { bigint: true }).nlink,
      2n,
      "root regression requires a writable, hard-linked root-owned Node source",
    );
    const rootOwnedMarker = path.join(root, "root-owned-node-snapshot.json");
    const rootOwnedPath = [bin, gitOnlyDir, rootOwnedNodeDir].join(
      path.delimiter,
    );
    const rootOwnedReview = reviewThroughAncestor(
      rootOwnedNode,
      rootOwnedPath,
      rootOwnedMarker,
      { AUTOREVIEW_TEST_NODE_SNAPSHOT_DIAGNOSTICS: "1" },
    );
    assert.equal(
      rootOwnedReview.status,
      0,
      `canonical wrapper rejected its root-owned toolcache-style Node ancestor:\n${rootOwnedReview.stderr || rootOwnedReview.stdout}`,
    );
    assert.doesNotMatch(rootOwnedReview.stderr, /root Node trust rejected at/);
    assertSealedNodeSnapshot(rootOwnedMarker, rootOwnedNode);

    for (const { label, gid, mode } of [
      { label: "setuid", gid: 0, mode: 0o4755 },
      { label: "setgid", gid: 65534, mode: 0o2755 },
    ]) {
      const setIdNodeDir = path.join(root, `${label}-node-bin`);
      const setIdNode = createNodeFixture(setIdNodeDir, {
        uid: 0,
        gid,
        mode,
      });
      const setIdMarker = path.join(root, `${label}-node-snapshot.json`);
      const setIdReview = reviewThroughAncestor(
        setIdNode,
        [bin, gitOnlyDir, setIdNodeDir].join(path.delimiter),
        setIdMarker,
        { AUTOREVIEW_TEST_NODE_SNAPSHOT_DIAGNOSTICS: "1" },
      );
      assert.notEqual(
        setIdReview.status,
        0,
        `canonical wrapper accepted ${label} Node source semantics`,
      );
      assert.match(setIdReview.stderr, /requires a trusted node executable/);
      assert.equal(
        setIdReview.stderr.match(/root Node trust rejected at/g)?.length,
        1,
        `${label} rejection must emit one bounded diagnostic stage`,
      );
      assert.match(
        setIdReview.stderr,
        /root Node trust rejected at source-proof/,
      );
      assert.equal(
        setIdReview.stderr.includes(setIdNodeDir),
        false,
        `${label} diagnostic leaked the rejected Node path`,
      );
      assert.equal(existsSync(setIdMarker), false);
    }

    const pathSwapNodeDir = path.join(root, "path-swap-node-bin");
    const pathSwapNode = createForeignNodeFixture(pathSwapNodeDir);
    const pathSwapLauncher = path.join(root, "node-path-swap-launcher.cjs");
    const pathSwapMarker = path.join(root, "path-swap-node-snapshot.json");
    writeFileSync(
      pathSwapLauncher,
      `const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const original = process.execPath;
const moved = original + ".live";
fs.renameSync(original, moved);
fs.copyFileSync(moved, original);
fs.chownSync(original, 65534, 65534);
fs.chmodSync(original, 0o755);
const result = spawnSync(process.argv[2], process.argv.slice(3), {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`,
    );
    const pathSwapReview = spawnSync(
      pathSwapNode,
      [pathSwapLauncher, wrapper, ...reviewArgs.slice(1)],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          AUTOREVIEW_FAKE_MUTATE_REPO: repo,
          AUTOREVIEW_FAKE_NODE_MARKER: pathSwapMarker,
          AUTOREVIEW_TEST_NODE_SNAPSHOT_DIAGNOSTICS: "1",
          PATH: [bin, gitOnlyDir, pathSwapNodeDir].join(path.delimiter),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.notEqual(
      pathSwapReview.status,
      0,
      "canonical wrapper accepted a PATH Node inode replaced after launch",
    );
    assert.match(pathSwapReview.stderr, /requires a trusted node executable/);
    assert.equal(
      pathSwapReview.stderr.match(/root Node trust rejected at/g)?.length,
      1,
      "path replacement must emit one bounded diagnostic stage",
    );
    assert.equal(
      pathSwapReview.stderr.includes(pathSwapNodeDir),
      false,
      "path replacement diagnostic leaked the rejected Node path",
    );
    assert.equal(existsSync(pathSwapMarker), false);

    const tamperMarker = path.join(root, "tampered-node-snapshot.json");
    const tamperedAliasReview = reviewThroughAncestor(
      foreignNode,
      rootOnlyPath,
      tamperMarker,
      { AUTOREVIEW_FAKE_ALIAS_TAMPER: "1" },
    );
    assert.notEqual(
      tamperedAliasReview.status,
      0,
      "semantic child alias replacement must fail closed",
    );
    assert.match(
      tamperedAliasReview.stderr,
      /attested Node library aliases changed/,
    );

    for (const { label, envKey } of [
      {
        label: "snapshot mode",
        envKey: "AUTOREVIEW_FAKE_SNAPSHOT_MODE_TAMPER",
      },
      { label: "closure manifest", envKey: "AUTOREVIEW_FAKE_MANIFEST_TAMPER" },
    ]) {
      const marker = path.join(
        root,
        `${label.replaceAll(" ", "-")}-tamper.json`,
      );
      const tamperedReview = reviewThroughAncestor(
        foreignNode,
        rootOnlyPath,
        marker,
        { [envKey]: "1" },
      );
      assert.notEqual(
        tamperedReview.status,
        0,
        `${label} tamper must fail closed`,
      );
      assert.match(
        tamperedReview.stderr,
        /attested Node|loader policy changed|resolved executable changed/,
      );
    }
  }

  const serialized = spawnSync(
    process.execPath,
    [script, "--serialize-untracked-file", "unrelated.tmp"],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(
    serialized.status,
    0,
    `safe untracked serialization failed: ${serialized.stderr}`,
  );
  assert.match(serialized.stdout, /path: "unrelated\.tmp"/);
  assert.match(serialized.stdout, /unrelated local churn/);

  const outside = path.join(root, "outside.txt");
  writeFileSync(outside, "must not be serialized\n");
  symlinkSync(outside, path.join(repo, "linked.tmp"));
  const linked = spawnSync(
    process.execPath,
    [script, "--serialize-untracked-file", "linked.tmp"],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /symlinked|regular file/);
  assert.doesNotMatch(linked.stdout, /must not be serialized/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("agent-autoreview target guard tests passed");
