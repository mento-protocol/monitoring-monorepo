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

function createForeignNodeFixture(directory) {
  const executable = path.join(directory, "node");
  mkdirSync(directory);
  chmodSync(directory, 0o700);
  copyFileSync(process.execPath, executable);
  chownSync(executable, 65534, 65534);
  chmodSync(executable, 0o755);
  assert.notEqual(lstatSync(executable, { bigint: true }).uid, 0n);
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
  const endMarker = '\n  \' "$candidate" "$require_interpreter"\n}';
  const endOffset = source.indexOf(endMarker, programOffset);
  assert.ok(functionOffset >= 0, "strict ELF metadata function is missing");
  assert.ok(programOffset >= 0, "strict ELF metadata program is missing");
  assert.ok(
    endOffset > programOffset,
    "strict ELF metadata program is malformed",
  );
  return source.slice(programOffset + programMarker.length, endOffset);
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
  const interpreterOffset = 256;
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
  const programHeaderCount = 2 + Number(withInterpreter) + Number(extraLoad);
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

function runStrictElfMetadata(fixture, requireInterpreter) {
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
      requireInterpreter ? "1" : "0",
    ],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
runStrictElfMetadata.sequence = 0;

function assertStrictElfAccepted(fixture, requireInterpreter = true) {
  const result = runStrictElfMetadata(fixture, requireInterpreter);
  assert.equal(
    result.status,
    0,
    "strict ELF parser rejected a valid fixture: " + result.stderr,
  );
  return result.stdout;
}

function assertStrictElfRejected(fixture, requireInterpreter = true) {
  const result = runStrictElfMetadata(fixture, requireInterpreter);
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
        false,
      );
    }
  }
  assertStrictElfRejected(syntheticElf({ withInterpreter: false }));
  assertStrictElfRejected(syntheticElf(), false);
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

try {
  exerciseStrictElfMetadataParser();
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
  '
fi
printf '%s\\n' 'unrelated local churn' >"$AUTOREVIEW_FAKE_MUTATE_REPO/unrelated.tmp"
printf '%s\\n' '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"fixture review","overall_confidence":1}'
`,
  );
  chmodSync(claude, 0o755);

  const currentNode = realpathSync(process.execPath);
  const currentNodeStat = lstatSync(currentNode, { bigint: true });
  const rootForeignCurrentNode =
    process.platform === "linux" &&
    process.geteuid?.() === 0 &&
    currentNodeStat.uid !== 0n;
  const inheritedNodeMarker = path.join(root, "inherited-node-snapshot.json");
  const reviewCommand = rootForeignCurrentNode ? wrapper : process.execPath;
  const reviewCommandArgs = rootForeignCurrentNode
    ? reviewArgs.slice(1)
    : reviewArgs;
  const result = spawnSync(reviewCommand, reviewCommandArgs, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      AUTOREVIEW_FAKE_MUTATE_REPO: repo,
      ...(rootForeignCurrentNode
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
  if (rootForeignCurrentNode) {
    assertSealedNodeSnapshot(inheritedNodeMarker, currentNode);
  }

  if (process.platform === "linux" && process.geteuid?.() === 0) {
    const foreignNodeDir = path.join(root, "foreign-node-bin");
    const foreignNode = createForeignNodeFixture(foreignNodeDir);
    const foreignNodeAlias = path.join(root, "foreign-node-hardlink");
    linkSync(foreignNode, foreignNodeAlias);
    assert.equal(
      lstatSync(foreignNode, { bigint: true }).nlink,
      2n,
      "root regression requires a hard-linked image-owned Node source",
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
    const wrapperReview = spawnSync(
      foreignNode,
      [launcher, wrapper, ...reviewArgs.slice(1)],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          AUTOREVIEW_FAKE_MUTATE_REPO: repo,
          AUTOREVIEW_FAKE_NODE_MARKER: wrapperMarker,
          PATH: rootOnlyPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
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

    const tamperMarker = path.join(root, "tampered-node-snapshot.json");
    const tamperedAliasReview = spawnSync(
      foreignNode,
      [launcher, wrapper, ...reviewArgs.slice(1)],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          AUTOREVIEW_FAKE_ALIAS_TAMPER: "1",
          AUTOREVIEW_FAKE_MUTATE_REPO: repo,
          AUTOREVIEW_FAKE_NODE_MARKER: tamperMarker,
          PATH: rootOnlyPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
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
