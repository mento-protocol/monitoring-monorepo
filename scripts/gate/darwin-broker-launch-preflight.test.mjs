import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  BROKER_CLIENT_ALLOWLIST,
  scanRepository,
  scanSource,
  validateAllowlist,
} from "./darwin-broker-launch-preflight.mjs";
import { mappedChildScrubbedEnvironmentName } from "./quality-gate-coordinator-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

function rulesFor(path, source) {
  return new Set(scanSource(path, source).map((finding) => finding.rule));
}

test("broker findings keep exact source line numbers", () => {
  const findings = scanSource(
    "tool.sh",
    [
      "#!/bin/bash",
      "printf 'safe\\n'",
      "",
      "open report.pdf",
      "launchctl print gui/501",
      "",
    ].join("\n"),
  );
  assert.equal(findings.find(({ evidence }) => evidence === "open")?.line, 4);
  assert.equal(
    findings.find(({ evidence }) => evidence === "launchctl")?.line,
    5,
  );
});

test("known broker launch and Unix client APIs fail closed", () => {
  const cases = [
    [
      "tool.sh",
      "launchctl kickstart gui/501/example\n",
      "shell-process-broker",
    ],
    ["tool.sh", "/bin/launchctl print gui/501\n", "shell-process-broker"],
    ["tool.sh", "osascript -e 'return 1'\n", "shell-process-broker"],
    ["tool.sh", "osascript /tmp/agentqg.scpt\n", "shell-process-broker"],
    ["tool.sh", "open -a Calculator\n", "shell-process-broker"],
    ["tool.sh", "open report.pdf\n", "shell-process-broker"],
    ["tool.sh", "open /tmp/report.pdf\n", "shell-process-broker"],
    ["tool.sh", "/usr/bin/open /tmp/report.pdf\n", "shell-process-broker"],
    ["tool.sh", "launchctl /tmp/agentqg.plist\n", "shell-process-broker"],
    ["tool.sh", "/usr/bin/nc -U /tmp/broker.sock\n", "shell-process-broker"],
    [
      "workflow.yml",
      "steps:\n  - run: open report.pdf\n",
      "shell-process-broker",
    ],
    [
      "workflow.yml",
      "steps:\n  - run: open /tmp/report.pdf\n",
      "shell-process-broker",
    ],
    ["tool.sh", "nc -U /tmp/broker.sock\n", "shell-process-broker"],
    [
      "tool.sh",
      "socat - UNIX-CONNECT:/tmp/broker.sock\n",
      "shell-process-broker",
    ],
    [
      "tool.sh",
      "curl --unix-socket /tmp/broker.sock http://local\n",
      "shell-process-broker",
    ],
    ["client.m", "NSXPCConnection *client;\n", "apple-process-broker-api"],
    [
      "client.c",
      "xpc_connection_create_mach_service(name, 0, 0);\n",
      "apple-process-broker-api",
    ],
    [
      "client.m",
      "LSOpenApplication(&params, 0);\n",
      "apple-process-broker-api",
    ],
    [
      "client.m",
      "[NSWorkspace.sharedWorkspace launchApplication:name];\n",
      "apple-process-broker-api",
    ],
    [
      "client.swift",
      "SMAppService.mainApp.register()\n",
      "apple-process-broker-api",
    ],
    [
      "client.c",
      "AESendMessage(&event, &reply, 0, timeout);\n",
      "apple-process-broker-api",
    ],
    [
      "client.py",
      "socket.socket(socket.AF_UNIX).connect(path)\n",
      "python-unix-client",
    ],
    ["client.go", 'net.Dial("unix", path)\n', "go-unix-client"],
    ["client.rs", "UnixStream::connect(path)?;\n", "rust-unix-client"],
    ["client.c", "socket(AF_UNIX, SOCK_STREAM, 0);\n", "native-unix-client"],
  ];
  for (const [path, source, expectedRule] of cases) {
    assert.ok(
      rulesFor(path, source).has(expectedRule),
      `${path} did not match ${expectedRule}: ${source}`,
    );
  }
});

test("named broker launches in JavaScript, Python, Go, and Rust fail closed", () => {
  const cases = [
    [
      "client.mjs",
      'import { spawn } from "node:child_process";\nspawn("/bin/launchctl", ["kickstart"]);\n',
      "javascript-process-broker",
    ],
    [
      "client.mjs",
      'import childProcess from "node:child_process";\nchildProcess.execFile("/usr/bin/osascript", ["-e", script]);\n',
      "javascript-process-broker",
    ],
    [
      "route.mjs",
      'let command = "open -a Calculator";\n',
      "javascript-process-broker",
    ],
    [
      "route.mjs",
      'command = "launchctl kickstart gui/501/example";\n',
      "javascript-process-broker",
    ],
    [
      "client.py",
      'import subprocess\nsubprocess.run(["launchctl", "kickstart", service])\n',
      "python-process-broker",
    ],
    [
      "client.py",
      'import os\nos.system("/usr/bin/osascript -e script")\n',
      "python-process-broker",
    ],
    [
      "client.py",
      'import subprocess\nsubprocess.Popen(["open", report])\n',
      "python-process-broker",
    ],
    [
      "client.go",
      'cmd := exec.Command("/bin/launchctl", "kickstart", service)\n',
      "go-process-broker",
    ],
    [
      "client.go",
      'cmd := exec.CommandContext(ctx, "/usr/bin/osascript", "-e", script)\n',
      "go-process-broker",
    ],
    ["client.go", 'cmd := exec.Command("open", report)\n', "go-process-broker"],
    [
      "client.rs",
      'let child = std::process::Command::new("/bin/launchctl").spawn()?;\n',
      "rust-process-broker",
    ],
    [
      "client.rs",
      'let child = Command::new("/usr/bin/osascript").spawn()?;\n',
      "rust-process-broker",
    ],
    [
      "client.rs",
      'let child = Command::new("open").arg(report).spawn()?;\n',
      "rust-process-broker",
    ],
    [
      "client.mjs",
      'import { spawn as run } from "node:child_process";\nrun("/bin/launchctl", args);\n',
      "javascript-process-broker",
    ],
    [
      "client.py",
      'from subprocess import Popen as run\nrun(["/usr/bin/osascript", "-e", script])\n',
      "python-process-broker",
    ],
    [
      "client.go",
      'runner := exec.Command\nrunner("/bin/launchctl", "kickstart", service)\n',
      "go-process-broker",
    ],
    [
      "client.rs",
      'use std::process::Command as Runner;\nRunner::new("/usr/bin/osascript").spawn()?;\n',
      "rust-process-broker",
    ],
  ];
  for (const [path, source, expectedRule] of cases) {
    assert.ok(
      rulesFor(path, source).has(expectedRule),
      `${path} did not match ${expectedRule}: ${source}`,
    );
  }
});

test("named broker detection covers obvious command construction", () => {
  const cases = [
    [
      "client.mjs",
      'import { spawn } from "node:child_process";\nspawn("launch" + "ctl", args);\n',
      "javascript-process-broker",
    ],
    [
      "client.py",
      'import subprocess\nsubprocess.run(["osa" + "script", "-e", script])\n',
      "python-process-broker",
    ],
    [
      "client.go",
      'cmd := exec.Command("op" + "en", report)\n',
      "go-process-broker",
    ],
    [
      "client.rs",
      'let command = concat!("launch", "ctl");\n',
      "rust-process-broker",
    ],
  ];
  for (const [path, source, expectedRule] of cases) {
    assert.ok(
      rulesFor(path, source).has(expectedRule),
      `${path} did not match ${expectedRule}: ${source}`,
    );
  }
});

test("package scripts are parsed and scanned as executable shell commands", () => {
  const source = `${JSON.stringify(
    {
      name: "fixture",
      scripts: {
        safe: "node ./safe.mjs",
        "test:cov": "open /tmp/report.pdf",
        automate: "osascript /tmp/agentqg.scpt",
      },
    },
    null,
    2,
  )}\n`;
  const findings = scanSource("package.json", source);
  assert.deepEqual(
    findings.map(({ line, rule, evidence }) => ({ line, rule, evidence })),
    [
      {
        line: 1,
        rule: "shell-process-broker",
        evidence: 'script "test:cov": open',
      },
      {
        line: 1,
        rule: "shell-process-broker",
        evidence: 'script "automate": osascript',
      },
    ],
  );
});

test("package script fields fail closed when they cannot be scanned", () => {
  assert.ok(
    rulesFor("package.json", '{"scripts":').has("unscanned-package-scripts"),
  );
  assert.ok(
    rulesFor("package.json", '{"scripts":{"test":false}}\n').has(
      "unscanned-package-scripts",
    ),
  );
  assert.ok(
    rulesFor(
      "package.json",
      '{"scripts":{"test":"op\\u0065n \\u002ftmp/report.pdf"}}\n',
    ).has("shell-process-broker"),
  );
  assert.deepEqual(
    scanSource(
      "package.json",
      '{"description":"open /tmp/report.pdf","scripts":{"test":"node ./test.mjs"}}\n',
    ),
    [],
  );
});

test("repository admission rejects broker package scripts before dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "darwin-package-preflight-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      '{"scripts":{"test:cov":"open /tmp/report.pdf"}}\n',
    );
    const result = scanRepository(root, {
      paths: ["package.json"],
      policyRoot: repoRoot,
    });
    assert.deepEqual(result.policyErrors, []);
    assert.ok(
      result.rejected.some(
        ({ path, rule }) =>
          path === "package.json" && rule === "shell-process-broker",
      ),
    );

    chmodSync(join(root, "package.json"), 0o755);
    const executableResult = scanRepository(root, {
      paths: ["package.json"],
      policyRoot: repoRoot,
    });
    assert.ok(
      executableResult.rejected.some(
        ({ path, rule }) =>
          path === "package.json" && rule === "opaque-executable",
      ),
    );

    rmSync(join(root, "package.json"));
    writeFileSync(
      join(root, "package.payload.json"),
      '{"scripts":{"test:cov":"open /tmp/report.pdf"}}\n',
    );
    symlinkSync("package.payload.json", join(root, "package.json"));
    const symlinkResult = scanRepository(root, {
      paths: ["package.json", "package.payload.json"],
      policyRoot: repoRoot,
    });
    assert.ok(
      symlinkResult.rejected.some(
        ({ path, rule }) =>
          path === "package.json" && rule === "unscanned-package-scripts",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository package scripts contain no broker trampoline", () => {
  const manifests = execFileSync("git", ["ls-files", "*package.json"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.ok(manifests.length > 0);
  const findings = manifests.flatMap((path) =>
    scanSource(path, readFileSync(join(repoRoot, path), "utf8")),
  );
  assert.deepEqual(findings, []);
});

test("Node net clients and obvious dynamic forms fail closed", () => {
  assert.ok(
    rulesFor(
      "client.mjs",
      'import { createConnection } from "node:net";\ncreateConnection(path);\n',
    ).has("node-net-client"),
  );
  assert.ok(
    rulesFor(
      "client.mjs",
      'import { createConnection as dial } from "node:net";\ndial(path);\n',
    ).has("node-net-client"),
  );
  assert.ok(
    rulesFor(
      "client.cjs",
      'const { connect: dial } = require("net");\ndial(path);\n',
    ).has("node-net-client"),
  );
  assert.ok(
    rulesFor(
      "client.mjs",
      'import net from "node:net";\nconst command = `${net.connect(path)}`;\n',
    ).has("node-net-client"),
  );
  assert.ok(
    rulesFor(
      "client.mjs",
      'import net from "node:net";\nnet["connect"](path);\n',
    ).has("node-net-client"),
  );
  assert.ok(
    rulesFor(
      "client.mjs",
      'const net = await import("node:" + "net");\nnet["connect"](path);\n',
    ).has("node-net-dynamic-client"),
  );
});

test("Node client detection does not retain regular-expression state", () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(
      scanSource(
        `safe-${attempt}.mjs`,
        'import { createServer } from "node:net";\ncreateServer();\n',
      ),
      [],
    );
    assert.ok(
      rulesFor(
        `dynamic-${attempt}.mjs`,
        'const net = await import("node:" + "net");\nnet["connect"](path);\n',
      ).has("node-net-dynamic-client"),
    );
    assert.ok(
      rulesFor(
        `computed-${attempt}.mjs`,
        'import net from "node:net";\nnet["connect"](path);\n',
      ).has("node-net-client"),
    );
  }
});

test("obvious constructed broker names fail closed", () => {
  assert.ok(
    rulesFor(
      "tool.sh",
      'broker_tool="launchctl"\n"$broker_tool" print gui/501\n',
    ).has("shell-process-broker"),
  );
  assert.ok(
    rulesFor(
      "client.py",
      'family = getattr(socket, "AF_" + "UNIX")\nsocket.socket(family)\n',
    ).has("python-unix-client"),
  );
  assert.ok(
    rulesFor(
      "client.go",
      'network := "un" + "ix"\nnet.Dial(network, path)\n',
    ).has("go-unix-client"),
  );
  assert.ok(
    rulesFor("client.rs", 'let network = concat!("un", "ix");\n').has(
      "rust-unix-client",
    ),
  );
});

test("obvious TCP clients and passive servers remain accepted", () => {
  assert.deepEqual(
    scanSource(
      "tcp.test.mjs",
      'import { connect, createServer } from "node:net";\nconnect(Number(port), host);\ncreateServer();\n',
    ),
    [],
  );
  assert.deepEqual(
    scanSource(
      "proxy.sh",
      'socat "TCP-LISTEN:8080,reuseaddr,fork" TCP:host:80\n',
    ),
    [],
  );
});

test("ordinary open identifiers and non-broker commands remain accepted", () => {
  const cases = [
    ["client.mjs", 'const state = "open";\nopen(report);\n'],
    ["client.mjs", 'const command = "reopen report";\n'],
    ["client.py", 'state = "open"\nfile = open(path)\n'],
    ["client.py", 'subprocess.run(["opener", report])\n'],
    ["client.go", "file, err := os.Open(path)\n"],
    ["client.rs", "let options = OpenOptions::new();\n"],
    [
      "client.mjs",
      'import { spawn as run } from "node:child_process";\nrun("echo", args);\n',
    ],
    [
      "client.py",
      'from subprocess import Popen as run\nrun(["python3", script])\n',
    ],
    ["client.go", 'runner := exec.Command\nrunner("printf", "safe")\n'],
    [
      "client.rs",
      'use std::process::Command as Runner;\nRunner::new("printf").spawn()?;\n',
    ],
  ];
  for (const [path, source] of cases) {
    assert.deepEqual(scanSource(path, source), [], `${path}: ${source}`);
  }
});

test("documentation, dependencies, and only scanner implementation are excluded", () => {
  const threat = "launchctl kickstart gui/501/example\n";
  assert.deepEqual(scanSource("docs/runbook.sh", threat), []);
  assert.deepEqual(scanSource("node_modules/tool/run.sh", threat), []);
  assert.deepEqual(
    scanSource("scripts/gate/darwin-broker-launch-preflight.mjs", threat),
    [],
  );
  assert.ok(
    rulesFor(
      "scripts/gate/darwin-broker-launch-preflight.test.mjs",
      'childProcess.spawn("launchctl", []);\n',
    ).has("javascript-process-broker"),
  );
});

test("the preflight exposes a data-URL-safe bound-source entry point", async () => {
  const source = readFileSync(
    join(repoRoot, "scripts/gate/darwin-broker-launch-preflight.mjs"),
  );
  const imported = await import(
    `data:text/javascript;base64,${source.toString("base64")}`
  );
  assert.equal(typeof imported.runDarwinBrokerPreflight, "function");
});

test("allowlist validation rejects stale, missing, and broadened policy", () => {
  assert.deepEqual(validateAllowlist(), []);

  const broadened = structuredClone(BROKER_CLIENT_ALLOWLIST);
  broadened.push({
    path: "scripts/**",
    rules: ["node-net-client"],
    sha256: "0".repeat(64),
    reason: "all clients are trusted",
  });
  assert.ok(
    validateAllowlist(broadened).some((error) => error.includes("unapproved")),
  );

  const changedReason = structuredClone(BROKER_CLIENT_ALLOWLIST);
  changedReason[0].reason = "trusted";
  assert.ok(
    validateAllowlist(changedReason).some((error) => error.includes("reason")),
  );

  const missing = structuredClone(BROKER_CLIENT_ALLOWLIST).slice(1);
  assert.ok(
    validateAllowlist(missing).some((error) => error.includes("missing")),
  );
});

function makePolicyFixture() {
  const root = mkdtempSync(join(tmpdir(), "darwin-broker-preflight-"));
  for (const entry of BROKER_CLIENT_ALLOWLIST) {
    const destination = join(root, entry.path);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    cpSync(join(repoRoot, entry.path), destination);
  }
  return root;
}

function thinMachOFixture(architecture = "arm64") {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0, 24);
  bytes.writeUInt32LE(0, 28);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  return bytes;
}

function fatMachOFixture(architecture = "arm64") {
  const thin = thinMachOFixture(architecture);
  const offset = 32;
  const bytes = Buffer.alloc(offset + thin.length);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(1, 4);
  bytes.writeUInt32BE(architecture === "arm64" ? 0x0100000c : 0x01000007, 8);
  bytes.writeUInt32BE(0, 12);
  bytes.writeUInt32BE(offset, 16);
  bytes.writeUInt32BE(thin.length, 20);
  bytes.writeUInt32BE(4, 24);
  thin.copy(bytes, offset);
  return bytes;
}

function terraformPackageH1(files) {
  const packageHash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )) {
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    packageHash.update(`${fileHash}  ${name}\n`);
  }
  return `h1:${packageHash.digest("base64")}`;
}

const DEFAULT_TERRAFORM_PROVIDER_BYTES = thinMachOFixture();
const TERRAFORM_PROVIDER_H1 = terraformPackageH1([
  ["LICENSE", Buffer.from("license\n")],
  ["terraform-provider-test_v1.2.3_x5", DEFAULT_TERRAFORM_PROVIDER_BYTES],
]);

function terraformRegistrySource(stackPaths = ["stack"]) {
  return `${JSON.stringify({
    version: 1,
    stacks: stackPaths.map((path) => ({ path })),
  })}\n`;
}

function terraformLockSource({
  address = "registry.terraform.io/example/test",
  version = "1.2.3",
  hashes = [TERRAFORM_PROVIDER_H1],
} = {}) {
  return (
    "# This file is maintained automatically by terraform init.\n\n" +
    `provider "${address}" {\n` +
    `  version = "${version}"\n` +
    "  hashes = [\n" +
    hashes.map((hash) => `    "${hash}",\n`).join("") +
    "  ]\n" +
    "}\n"
  );
}

function makeTerraformProviderFixture({
  target = "darwin_arm64",
  executableName = "terraform-provider-test_v1.2.3_x5",
  executableBytes = DEFAULT_TERRAFORM_PROVIDER_BYTES,
  lock,
  trustedRegistry = true,
  trustedLock = true,
  trustedStackPaths = ["stack"],
  registrySource = terraformRegistrySource(trustedStackPaths),
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "darwin-terraform-provider-"));
  const registryPath = "terraform.stacks.json";
  const lockPath = "stack/.terraform.lock.hcl";
  const packagePath =
    `stack/.terraform-agent-gate/providers/registry.terraform.io/` +
    `example/test/1.2.3/${target}`;
  const executablePath = `${packagePath}/${executableName}`;
  const licensePath = `${packagePath}/LICENSE`;
  const h1 = terraformPackageH1([
    ["LICENSE", Buffer.from("license\n")],
    [executableName, executableBytes],
  ]);
  const lockSource = lock ?? terraformLockSource({ hashes: [h1] });
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "stack"), { recursive: true });
  const trustedPaths = [];
  if (trustedRegistry) {
    writeFileSync(join(root, registryPath), registrySource);
    trustedPaths.push(registryPath);
  }
  if (trustedLock) {
    writeFileSync(join(root, lockPath), lockSource);
    trustedPaths.push(lockPath);
  }
  execFileSync("/usr/bin/git", ["add", "--", ...trustedPaths], { cwd: root });
  execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Gate Test",
      "-c",
      "user.email=gate-test@example.invalid",
      "commit",
      "-qm",
      "trusted Terraform policy",
    ],
    { cwd: root },
  );
  execFileSync(
    "/usr/bin/git",
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
    { cwd: root },
  );
  const branchOnlyPaths = [];
  if (!trustedRegistry) {
    writeFileSync(join(root, registryPath), registrySource);
    branchOnlyPaths.push(registryPath);
  }
  if (!trustedLock) {
    writeFileSync(join(root, lockPath), lockSource);
    branchOnlyPaths.push(lockPath);
  }
  if (branchOnlyPaths.length > 0) {
    execFileSync("/usr/bin/git", ["add", "--", ...branchOnlyPaths], {
      cwd: root,
    });
    execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "user.name=Gate Test",
        "-c",
        "user.email=gate-test@example.invalid",
        "commit",
        "-qm",
        "current branch Terraform policy",
      ],
      { cwd: root },
    );
  }
  mkdirSync(join(root, packagePath), { recursive: true });
  writeFileSync(join(root, licensePath), "license\n");
  writeFileSync(join(root, executablePath), executableBytes);
  chmodSync(join(root, executablePath), 0o755);
  return {
    h1,
    root,
    registryPath,
    lockPath,
    packagePath,
    executablePath,
    licensePath,
    paths: [licensePath, executablePath],
  };
}

function scanTerraformProviderFixture(fixture, options = {}) {
  return scanRepository(fixture.root, {
    paths: fixture.paths,
    trackedPaths: [fixture.registryPath, fixture.lockPath],
    policyRoot: repoRoot,
    platformName: "darwin",
    architecture: "arm64",
    ...options,
  });
}

test("a Darwin Terraform provider package passes exact lock h1 attestation", () => {
  const fixture = makeTerraformProviderFixture();
  try {
    const result = scanTerraformProviderFixture(fixture);
    assert.deepEqual(result.policyErrors, []);
    assert.deepEqual(result.rejected, []);
    assert.ok(
      result.accepted.some(
        (finding) =>
          finding.path === fixture.executablePath &&
          finding.rule === "attested-terraform-provider" &&
          finding.evidence.includes(fixture.h1),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation rejects a matching malicious worktree lock", () => {
  const fixture = makeTerraformProviderFixture();
  try {
    const maliciousBytes = thinMachOFixture();
    maliciousBytes[55] = 9;
    const maliciousH1 = terraformPackageH1([
      ["LICENSE", Buffer.from("license\n")],
      ["terraform-provider-test_v1.2.3_x5", maliciousBytes],
    ]);
    writeFileSync(join(fixture.root, fixture.executablePath), maliciousBytes);
    writeFileSync(
      join(fixture.root, fixture.lockPath),
      terraformLockSource({ hashes: [maliciousH1] }),
    );
    const result = scanTerraformProviderFixture(fixture);
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes("differs from its trusted mainline blob"),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation rejects staged mainline policy drift", () => {
  const fixture = makeTerraformProviderFixture();
  try {
    writeFileSync(
      join(fixture.root, fixture.lockPath),
      `${readFileSync(join(fixture.root, fixture.lockPath), "utf8")}\n`,
    );
    execFileSync("/usr/bin/git", ["add", "--", fixture.lockPath], {
      cwd: fixture.root,
    });
    const result = scanTerraformProviderFixture(fixture);
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes("differs from its trusted mainline blob"),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation rejects missing trusted policy blobs", () => {
  for (const [label, options, expected] of [
    [
      "registry",
      { trustedRegistry: false },
      "trusted Terraform stack registry is unavailable",
    ],
    [
      "lock",
      { trustedLock: false },
      "trusted Terraform dependency lock is unavailable",
    ],
  ]) {
    const fixture = makeTerraformProviderFixture(options);
    try {
      const result = scanTerraformProviderFixture(fixture);
      assert.ok(
        result.rejected.some(
          (finding) =>
            finding.rule === "unattested-terraform-provider" &&
            finding.evidence.includes(expected),
        ),
        label,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("Terraform provider attestation rejects malformed trusted policy blobs", () => {
  for (const [label, options, expected] of [
    [
      "registry",
      { registrySource: "{\n" },
      "Terraform stack registry is malformed",
    ],
    [
      "lock",
      { lock: "provider malformed\n" },
      "Terraform dependency lock file is malformed",
    ],
  ]) {
    const fixture = makeTerraformProviderFixture(options);
    try {
      const result = scanTerraformProviderFixture(fixture);
      assert.ok(
        result.rejected.some(
          (finding) =>
            finding.rule === "unattested-terraform-provider" &&
            finding.evidence.includes(expected),
        ),
        label,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("Terraform provider attestation rejects a newly self-registered stack", () => {
  const fixture = makeTerraformProviderFixture({
    trustedStackPaths: ["other"],
  });
  try {
    writeFileSync(
      join(fixture.root, fixture.registryPath),
      terraformRegistrySource(["other", "stack"]),
    );
    const result = scanTerraformProviderFixture(fixture);
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes(
            "registry differs from its trusted mainline blob",
          ),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation rejects a missing trusted mainline ref", () => {
  const fixture = makeTerraformProviderFixture();
  try {
    execFileSync(
      "/usr/bin/git",
      ["update-ref", "-d", "refs/remotes/origin/main"],
      { cwd: fixture.root },
    );
    const result = scanTerraformProviderFixture(fixture);
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes(
            "trusted origin/main commit is unavailable",
          ),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation validates thin and fat Mach-O CPU headers", () => {
  const acceptedFat = makeTerraformProviderFixture({
    executableBytes: fatMachOFixture("arm64"),
  });
  try {
    const result = scanTerraformProviderFixture(acceptedFat);
    assert.deepEqual(result.rejected, []);
    assert.ok(
      result.accepted.some(
        (finding) => finding.rule === "attested-terraform-provider",
      ),
    );
  } finally {
    rmSync(acceptedFat.root, { recursive: true, force: true });
  }

  for (const [label, executableBytes, evidence] of [
    [
      "truncated thin",
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 1, 2, 3]),
      "Mach-O slice is out of bounds",
    ],
    [
      "truncated fat",
      Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 1]),
      "architecture table is truncated",
    ],
    [
      "cross-architecture thin",
      thinMachOFixture("amd64"),
      "CPU does not match",
    ],
    [
      "cross-architecture fat",
      fatMachOFixture("amd64"),
      "no unique current CPU slice",
    ],
  ]) {
    const fixture = makeTerraformProviderFixture({ executableBytes });
    try {
      const result = scanTerraformProviderFixture(fixture);
      assert.ok(
        result.rejected.some(
          (finding) =>
            finding.rule === "unattested-terraform-provider" &&
            finding.evidence.includes(evidence),
        ),
        label,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("Terraform provider attestation rejects changed bytes and lock identity drift", () => {
  const cases = [
    {
      label: "changed provider bytes",
      mutate(fixture) {
        writeFileSync(
          join(fixture.root, fixture.executablePath),
          Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 9, 9, 9, 9]),
        );
      },
    },
    {
      label: "different source address",
      mutate(fixture) {
        writeFileSync(
          join(fixture.root, fixture.lockPath),
          terraformLockSource({
            address: "registry.terraform.io/other/test",
          }),
        );
      },
    },
    {
      label: "different selected version",
      mutate(fixture) {
        writeFileSync(
          join(fixture.root, fixture.lockPath),
          terraformLockSource({ version: "1.2.4" }),
        );
      },
    },
    {
      label: "no matching h1 checksum",
      mutate(fixture) {
        writeFileSync(
          join(fixture.root, fixture.lockPath),
          terraformLockSource({ hashes: [`zh:${"0".repeat(64)}`] }),
        );
      },
    },
  ];
  for (const fixtureCase of cases) {
    const fixture = makeTerraformProviderFixture();
    try {
      fixtureCase.mutate(fixture);
      const result = scanTerraformProviderFixture(fixture);
      assert.ok(
        result.rejected.some(
          (finding) => finding.rule === "unattested-terraform-provider",
        ),
        fixtureCase.label,
      );
      assert.ok(
        !result.accepted.some(
          (finding) => finding.rule === "attested-terraform-provider",
        ),
        fixtureCase.label,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("Terraform provider attestation rejects untracked locks and wrong platform paths", () => {
  const untracked = makeTerraformProviderFixture();
  try {
    const result = scanTerraformProviderFixture(untracked, {
      trackedPaths: [untracked.registryPath],
    });
    assert.ok(
      result.rejected.some(
        (finding) => finding.rule === "unattested-terraform-provider",
      ),
    );
  } finally {
    rmSync(untracked.root, { recursive: true, force: true });
  }

  const wrongPlatform = makeTerraformProviderFixture({
    target: "darwin_amd64",
  });
  try {
    const result = scanTerraformProviderFixture(wrongPlatform);
    assert.ok(
      result.rejected.some((finding) => finding.rule === "opaque-executable"),
    );
    assert.ok(
      !result.accepted.some(
        (finding) => finding.rule === "attested-terraform-provider",
      ),
    );
  } finally {
    rmSync(wrongPlatform.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation rejects unregistered data directories", () => {
  const fixture = makeTerraformProviderFixture();
  try {
    writeFileSync(
      join(fixture.root, fixture.registryPath),
      `${JSON.stringify({ version: 1, stacks: [{ path: "other" }] })}\n`,
    );
    const result = scanTerraformProviderFixture(fixture);
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes(
            "registry differs from its trusted mainline blob",
          ),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation rejects extra executables, names, and links", () => {
  const extraExecutable = makeTerraformProviderFixture();
  try {
    const extraPath = join(
      extraExecutable.root,
      extraExecutable.packagePath,
      "helper",
    );
    writeFileSync(extraPath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
    chmodSync(extraPath, 0o755);
    const result = scanTerraformProviderFixture(extraExecutable);
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes("additional opaque executable"),
      ),
    );
  } finally {
    rmSync(extraExecutable.root, { recursive: true, force: true });
  }

  const wrongName = makeTerraformProviderFixture({
    executableName: "provider-test",
  });
  try {
    const result = scanTerraformProviderFixture(wrongName);
    assert.ok(
      result.rejected.some(
        (finding) => finding.rule === "unattested-terraform-provider",
      ),
    );
  } finally {
    rmSync(wrongName.root, { recursive: true, force: true });
  }

  for (const linkKind of ["symbolic", "hard"]) {
    const fixture = makeTerraformProviderFixture();
    const external = join(
      tmpdir(),
      `darwin-provider-link-${linkKind}-${process.pid}-${Date.now()}`,
    );
    try {
      writeFileSync(
        external,
        Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 1, 2, 3]),
      );
      chmodSync(external, 0o755);
      rmSync(join(fixture.root, fixture.executablePath));
      if (linkKind === "symbolic") {
        symlinkSync(external, join(fixture.root, fixture.executablePath));
      } else {
        linkSync(external, join(fixture.root, fixture.executablePath));
      }
      const result = scanTerraformProviderFixture(fixture);
      assert.ok(
        result.rejected.some(
          (finding) => finding.rule === "unattested-terraform-provider",
        ),
        linkKind,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(external, { force: true });
    }
  }
});

test("Terraform provider attestation rejects a package mutation during hashing", () => {
  const fixture = makeTerraformProviderFixture();
  try {
    const result = scanTerraformProviderFixture(fixture, {
      providerPackageHashHook({ executablePath }) {
        writeFileSync(
          executablePath,
          Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 8, 8, 8, 8, 8]),
        );
      },
    });
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes("changed during attestation"),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation rejects lock mutation during hashing", () => {
  const fixture = makeTerraformProviderFixture();
  try {
    const result = scanTerraformProviderFixture(fixture, {
      providerPackageHashHook() {
        writeFileSync(
          join(fixture.root, fixture.lockPath),
          `${readFileSync(join(fixture.root, fixture.lockPath), "utf8")}\n`,
        );
      },
    });
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes(
            "lock differs from its trusted mainline blob",
          ),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Terraform provider attestation rejects ancestor replacement during hashing", () => {
  const fixture = makeTerraformProviderFixture();
  try {
    const dataDirectory = join(fixture.root, "stack/.terraform-agent-gate");
    const movedDirectory = `${dataDirectory}.moved`;
    const result = scanTerraformProviderFixture(fixture, {
      providerPackageHashHook() {
        renameSync(dataDirectory, movedDirectory);
        symlinkSync(movedDirectory, dataDirectory, "dir");
      },
    });
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.rule === "unattested-terraform-provider" &&
          finding.evidence.includes("unsafe directory ancestry"),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("current allowlisted coordinator protocols pass exact source attestation", () => {
  const root = makePolicyFixture();
  try {
    const paths = BROKER_CLIENT_ALLOWLIST.map((entry) => entry.path);
    const result = scanRepository(root, { paths, policyRoot: repoRoot });
    assert.deepEqual(result.policyErrors, []);
    assert.deepEqual(result.rejected, []);
    assert.ok(result.accepted.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a small fixture repo does not need to duplicate policy sources", () => {
  const root = mkdtempSync(join(tmpdir(), "darwin-broker-small-fixture-"));
  try {
    writeFileSync(join(root, "fixture.txt"), "fixture\n");
    const result = scanRepository(root, {
      paths: ["fixture.txt"],
      policyRoot: repoRoot,
    });
    assert.deepEqual(result.policyErrors, []);
    assert.deepEqual(result.rejected, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untracked broker source is rejected before it can be dispatched", () => {
  const root = makePolicyFixture();
  const threatPath = "scripts/untracked-broker.mjs";
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, threatPath),
      'import { createConnection } from "node:net";\ncreateConnection("/tmp/process-broker.sock");\n',
    );
    const paths = [
      ...BROKER_CLIENT_ALLOWLIST.map((entry) => entry.path),
      threatPath,
    ];
    const result = scanRepository(root, { paths, policyRoot: repoRoot });
    assert.deepEqual(result.policyErrors, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].path, threatPath);
    assert.equal(result.rejected[0].rule, "node-net-client");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gitignored broker source remains inside the repository boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "darwin-broker-ignored-fixture-"));
  try {
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "ignored-client.mjs\n");
    writeFileSync(
      join(root, "ignored-client.mjs"),
      'import net from "node:net";\nnet.connect("/tmp/process-broker.sock");\n',
    );
    const result = scanRepository(root, { policyRoot: repoRoot });
    assert.deepEqual(result.policyErrors, []);
    assert.ok(
      result.rejected.some(
        (finding) =>
          finding.path === "ignored-client.mjs" &&
          finding.rule === "node-net-client",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unenumerated or external source symlink fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "darwin-broker-symlink-fixture-"));
  const outside = join(tmpdir(), `darwin-broker-outside-${process.pid}.mjs`);
  try {
    writeFileSync(outside, 'import net from "node:net";\nnet.connect(path);\n');
    symlinkSync(outside, join(root, "client.mjs"));
    const result = scanRepository(root, {
      paths: ["client.mjs"],
      policyRoot: repoRoot,
    });
    assert.deepEqual(result.policyErrors, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].rule, "unscanned-source-symlink");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("the gate runs the preflight before lease or mapped-command launch", () => {
  const source = readFileSync(
    join(repoRoot, "scripts/agent-quality-gate.sh"),
    "utf8",
  );
  const runWithTimeout = source.indexOf("run_with_timeout() {");
  const lineage = source.indexOf("gate_darwin_lineage_prepare", runWithTimeout);
  const dispatchPreflight = source.indexOf(
    "if ! gate_darwin_broker_preflight;",
    lineage,
  );
  const launchStateRecorded = source.indexOf(
    "last_command_launch_state=started",
    dispatchPreflight,
  );
  assert.ok(runWithTimeout >= 0);
  assert.ok(lineage > runWithTimeout);
  assert.ok(dispatchPreflight > lineage);
  assert.ok(launchStateRecorded > dispatchPreflight);
});

test("mapped Terraform commands use an empty CLI config and scrub bypass controls", () => {
  for (const name of [
    "TERRAFORM_CONFIG",
    "TF_CLI_CONFIG_FILE",
    "TF_PLUGIN_CACHE_DIR",
    "TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE",
    "TF_REATTACH_PROVIDERS",
    "TF_CLI_ARGS",
    "TF_CLI_ARGS_validate",
  ]) {
    assert.equal(
      mappedChildScrubbedEnvironmentName(name),
      true,
      `${name} must not reach mapped Terraform commands`,
    );
  }
  assert.equal(mappedChildScrubbedEnvironmentName("TF_VAR_example"), false);

  const source = readFileSync(
    join(repoRoot, "scripts/agent-quality-gate.sh"),
    "utf8",
  );
  const scrubScan = source.indexOf("--mapped-child-scrubbed-names");
  const emptyConfig = source.indexOf("TF_CLI_CONFIG_FILE=/dev/null", scrubScan);
  const mappedShell = source.indexOf("/bin/bash -p", emptyConfig);
  assert.ok(scrubScan >= 0);
  assert.ok(emptyConfig > scrubScan);
  assert.ok(mappedShell > emptyConfig);
});

test("opaque executable magic fails closed without an executable mode bit", () => {
  const root = makePolicyFixture();
  const threatPath = "bin/opaque-helper";
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(
      join(root, threatPath),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]),
    );
    const result = scanRepository(root, {
      paths: [threatPath],
      policyRoot: repoRoot,
    });
    assert.deepEqual(result.policyErrors, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].rule, "opaque-executable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a source change invalidates an exact coordinator exception", () => {
  const root = makePolicyFixture();
  const entry = BROKER_CLIENT_ALLOWLIST[0];
  try {
    writeFileSync(join(root, entry.path), "// source changed\n");
    const paths = BROKER_CLIENT_ALLOWLIST.map((item) => item.path);
    const result = scanRepository(root, { paths });
    assert.ok(
      result.policyErrors.some((error) =>
        error.includes("source hash is stale"),
      ),
    );
    assert.ok(
      result.policyErrors.some((error) =>
        error.includes("broker capability is stale"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
