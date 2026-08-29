#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PATH = "scripts/gate/darwin-broker-launch-preflight.mjs";
const TEST_PATH = "scripts/gate/darwin-broker-launch-preflight.test.mjs";
const PACKAGE_MANIFEST_BASENAME = "package.json";
const PACKAGE_SCRIPT_SHELL_COMMAND_STRING =
  /(?:^|[\s;&|()])(?:[^\s;&|()]+\/)*(?:[bB][aA][sS][hH]|[cC][sS][hH]|[dD][aA][sS][hH]|[fF][iI][sS][hH]|[kK][sS][hH]|[sS][hH]|[tT][cC][sS][hH]|[zZ][sS][hH])(?=\s)[^;&|()\n]*(?:^|\s)(?:-[a-z]*c[a-z]*|--(?:command|init-command)(?:=\S*)?)(?=\s|$)/mu;
const PACKAGE_SCRIPT_FISH_INIT_COMMAND_STRING =
  /(?:^|[\s;&|()])(?:[^\s;&|()]+\/)*[fF][iI][sS][hH](?=\s)[^;&|()\n]*(?:^|\s)-C\S*(?=\s|$)/mu;

// This admission check has a narrow claim. It rejects named process-broker
// APIs, obvious constructed forms, unapproved Unix-domain clients, and opaque
// repository executables. Static source inspection cannot identify arbitrary
// runtime string construction or a broker hidden in a dependency or existing
// system binary. Those forms remain unsupported by the Darwin lineage
// contract and require a separate OS-enforced containment boundary.

const SOURCE_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cjs",
  ".go",
  ".h",
  ".html",
  ".js",
  ".jsx",
  ".m",
  ".mjs",
  ".mm",
  ".py",
  ".rs",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
  ".zsh",
]);

const SOURCE_BASENAMES = new Set(["Dockerfile", "Makefile", "Rakefile"]);

const ROOT_EXCLUDED_PREFIXES = [
  ".git/",
  ".investigations/",
  ".rankings/",
  ".reviews/",
  ".tmp/",
  "coverage/",
  "dist/",
  "docs/",
  "node_modules/",
  "vendor/",
];

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".investigations",
  ".next",
  ".pnpm-store",
  ".rankings",
  ".reviews",
  ".tmp",
  ".trunk",
  ".turbo",
  "coverage",
  "dist",
  "docs",
  "node_modules",
  "vendor",
]);

const IGNORED_PATH_EXCLUSIONS = [...EXCLUDED_DIRECTORY_NAMES].flatMap(
  (name) => [`:(exclude,glob)${name}/**`, `:(exclude,glob)**/${name}/**`],
);

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_REPOSITORY_PATHS = 200_000;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_TERRAFORM_PROVIDER_FILES = 128;
const MAX_TERRAFORM_PROVIDER_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TERRAFORM_PROVIDER_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TERRAFORM_STACK_REGISTRY_BYTES = 1024 * 1024;
const MAX_TERRAFORM_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_MACH_O_LOAD_COMMAND_BYTES = 16 * 1024 * 1024;
const MAX_FAT_MACH_O_ARCHITECTURES = 32;
const TERRAFORM_PROVIDER_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const TERRAFORM_PROVIDER_VERSION =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const TERRAFORM_PACKAGE_ENTRY_SEGMENT = /^[A-Za-z0-9._+-]+$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const EXCLUDED_EXACT_PATHS = new Set([HELPER_PATH]);

// These fragments match a named broker only when source uses it as an
// executable. The path fragment accepts relative and absolute executable
// paths. The constructed fragment covers the small, obvious concatenations
// that static inspection can identify without evaluating source.
const NAMED_BROKER_LITERAL_SOURCE =
  "[\"'`](?:/?(?:[^/\"'`\\s(),]+/)*)?(?:launchctl|osascript|open)(?=[\"'`\\s])";
const NAMED_BROKER_CONSTRUCTED_SOURCE = `(?:${[
  "[\"'`]launch[\"'`]\\s*\\+\\s*[\"'`]ctl[\"'`]",
  "[\"'`]osa[\"'`]\\s*\\+\\s*[\"'`]script[\"'`]",
  "[\"'`]op[\"'`]\\s*\\+\\s*[\"'`]en[\"'`]",
  "concat!\\s*\\(\\s*[\"'`]launch[\"'`]\\s*,\\s*[\"'`]ctl[\"'`]\\s*\\)",
  "concat!\\s*\\(\\s*[\"'`]osa[\"'`]\\s*,\\s*[\"'`]script[\"'`]\\s*\\)",
  "concat!\\s*\\(\\s*[\"'`]op[\"'`]\\s*,\\s*[\"'`]en[\"'`]\\s*\\)",
].join("|")})`;
const NAMED_BROKER_EXPRESSION_SOURCE = `(?:${NAMED_BROKER_LITERAL_SOURCE}|${NAMED_BROKER_CONSTRUCTED_SOURCE})`;

function namedBrokerPattern(prefix) {
  return new RegExp(`${prefix}${NAMED_BROKER_EXPRESSION_SOURCE}`, "gmu");
}

const RULES = [
  {
    id: "shell-process-broker",
    languages: new Set(["shell", "workflow"]),
    patterns: [
      /(?:^|[;&|()])[ \t]*(?:then\s+)?(?:(?:command|exec|env|sudo)\s+)*(?:["']?(?:[^"';&|()\s]+\/)?launchctl["']?)(?=\s+[^=!<>|&{+*%,)])/gmu,
      /(?:^|[;&|()])[ \t]*(?:then\s+)?(?:(?:command|exec|env|sudo)\s+)*(?:["']?(?:[^"';&|()\s]+\/)?osascript["']?)(?=\s+[^=!<>|&{+*%,)])/gmu,
      /(?:^|[;&|()])[ \t]*(?:then\s+)?(?:(?:command|exec|env|sudo)\s+)*(?:["']?(?:[^"';&|()\s]+\/)?open["']?)(?=\s+[^=!<>|&{+*%,)])/gmu,
      /(?:^|[;&|()])[ \t]*(?:then\s+)?(?:(?:command|exec|env|sudo)\s+)*(?:["']?(?:[^"';&|()\s]+\/)?(?:nc|ncat)["']?)\s+[^\n;&|]*-U(?:\s|$)/gmu,
      /(?:^|[;&|()])[ \t]*(?:then\s+)?(?:(?:command|exec|env|sudo)\s+)*(?:["']?(?:[^"';&|()\s]+\/)?socat["']?)\s+[^\n;&|]*(?:UNIX-CONNECT|UNIX-CLIENT|ABSTRACT-CONNECT):/gimu,
      /(?:^|[;&|()])[ \t]*(?:then\s+)?(?:(?:command|exec|env|sudo)\s+)*(?:["']?(?:[^"';&|()\s]+\/)?curl["']?)\s+[^\n;&|]*--unix-socket(?:\s|=)/gmu,
      /\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?(?:launchctl|osascript)\b/gmu,
    ],
  },
  {
    id: "shell-process-broker",
    languages: new Set(["workflow"]),
    patterns: [
      /^[ \t]*(?:-\s*)?run:\s*(?:(?:command|exec|env|sudo)\s+)*["']?(?:[^"';&|()\s]+\/)?(?:launchctl|osascript|open)["']?(?=\s+[^=!<>|&{+*%,)])/gmu,
      /^[ \t]*(?:-\s*)?run:\s*(?:(?:command|exec|env|sudo)\s+)*["']?(?:[^"';&|()\s]+\/)?(?:nc|ncat)["']?\s+[^\n;&|]*-U(?:\s|$)/gmu,
      /^[ \t]*(?:-\s*)?run:\s*(?:(?:command|exec|env|sudo)\s+)*["']?(?:[^"';&|()\s]+\/)?socat["']?\s+[^\n;&|]*(?:UNIX-CONNECT|UNIX-CLIENT|ABSTRACT-CONNECT):/gimu,
      /^[ \t]*(?:-\s*)?run:\s*(?:(?:command|exec|env|sudo)\s+)*["']?(?:[^"';&|()\s]+\/)?curl["']?\s+[^\n;&|]*--unix-socket(?:\s|=)/gmu,
    ],
  },
  {
    id: "apple-process-broker-api",
    languages: new Set(["native", "swift"]),
    patterns: [
      /\bNSXPCConnection\b|\bxpc_connection_create(?:_mach_service)?\b/gmu,
      /\b(?:LSOpen\w*|LSLaunch\w*|LSApplicationWorkspace)\b/gmu,
      /\bNSWorkspace\b[\s\S]{0,160}\b(?:openApplication|launchApplication|openURL)\b/gmu,
      /\b(?:SMJobBless|SMLoginItemSetEnabled|SMAppService)\b/gmu,
      /\b(?:NSAppleScript|SBApplication)\b/gmu,
      /\bAESend(?:Message)?\s*\(/gmu,
    ],
  },
  {
    id: "javascript-process-broker",
    languages: new Set(["javascript"]),
    patterns: [
      namedBrokerPattern(
        "\\b(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?(?:execFileSync|execFile|execSync|exec|spawnSync|spawn)\\s*\\(\\s*",
      ),
      namedBrokerPattern("\\b(?:command|cmd|executable|binary)\\s*(?:=|:)\\s*"),
    ],
  },
  {
    id: "python-process-broker",
    languages: new Set(["python"]),
    patterns: [
      namedBrokerPattern(
        "\\bsubprocess\\s*\\.\\s*(?:run|Popen|call|check_call|check_output)\\s*\\(\\s*(?:[[(]\\s*)?",
      ),
      namedBrokerPattern("\\bos\\s*\\.\\s*(?:system|popen)\\s*\\(\\s*"),
      namedBrokerPattern("\\b(?:command|cmd|executable|binary)\\s*=\\s*"),
    ],
  },
  {
    id: "go-process-broker",
    languages: new Set(["go"]),
    patterns: [
      namedBrokerPattern(
        "\\b[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*Command\\s*\\(\\s*",
      ),
      namedBrokerPattern(
        "\\b[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*CommandContext\\s*\\(\\s*[^,\\n]+,\\s*",
      ),
      namedBrokerPattern(
        "\\b(?:command|cmd|executable|binary)\\s*(?::=|=)\\s*",
      ),
    ],
  },
  {
    id: "rust-process-broker",
    languages: new Set(["rust"]),
    patterns: [
      namedBrokerPattern(
        "\\b(?:std\\s*::\\s*process\\s*::\\s*)?Command\\s*::\\s*new\\s*\\(\\s*",
      ),
      namedBrokerPattern("\\b(?:command|cmd|executable|binary)\\s*=\\s*"),
    ],
  },
  {
    id: "python-unix-client",
    languages: new Set(["python"]),
    patterns: [
      /\b(?:socket\.)?AF_UNIX\b/gmu,
      /\bAF_["']\s*\+\s*["']UNIX\b/gmu,
      /\b(?:create_unix_connection|open_unix_connection)\s*\(/gmu,
      /\bsocket\s*\.\s*connect(?:_ex)?\s*\(/gmu,
    ],
  },
  {
    id: "go-unix-client",
    languages: new Set(["go"]),
    patterns: [
      /\b(?:net\.)?(?:DialUnix|ResolveUnixAddr)\s*\(/gmu,
      /\b(?:net\.)?Dial(?:Timeout|er[^.]*)?\s*\([^\n]{0,160}["'`]unix/gmu,
      /["'`]un["'`]\s*\+\s*["'`]ix["'`]/gmu,
      /\bUnixConn\b/gmu,
    ],
  },
  {
    id: "rust-unix-client",
    languages: new Set(["rust"]),
    patterns: [
      /\b(?:UnixStream|UnixDatagram)\s*::\s*connect\s*\(/gmu,
      /\b(?:tokio|async_std)\s*::[\s\S]{0,120}\bUnixStream\b/gmu,
      /\bconcat!\s*\(\s*["'`]un["'`]\s*,\s*["'`]ix["'`]\s*\)/gmu,
    ],
  },
  {
    id: "native-unix-client",
    languages: new Set(["native", "swift"]),
    patterns: [/\bAF_UNIX\b|\bPF_UNIX\b/gmu, /\bsun_path\b/gmu],
  },
];

const NODE_NET_MODULE = /(?:node:net|["'`]net["'`])/u;
const NODE_CLIENT_SYMBOL = /\b(?:createConnection|connect|Socket)\b/u;
const NODE_CLIENT_CALL =
  /\b(?:createConnection|connect)\s*\(|\.\s*(?:createConnection|connect)\s*\(|\[\s*["'`](?:createConnection|connect)["'`]\s*\]\s*\(/gmu;
const NODE_COMPUTED_CLIENT_CALL =
  /\[\s*["'`](?:createConnection|connect)["'`]\s*\]\s*\(/gmu;
const NODE_DYNAMIC_NET =
  /(?:require|import)\s*\(\s*["'`]node:?['"`]\s*\+\s*(?:["'`]:["'`]\s*\+\s*)?["'`]net["'`]\s*\)/gmu;
const NODE_TEMPLATE_CLIENT_CALL =
  /\$\{[^}\n]{0,200}\b(?:createConnection|connect)\s*\(/gmu;

const APPROVED_ALLOWLIST_SHAPE = new Map([
  [
    "scripts/gate/quality-gate-coordinator-client.mjs",
    {
      rules: ["node-net-client"],
      reason:
        "This client can only send the fixed quality-gate coordinator RPC protocol to the private coordinator socket. The protocol cannot request external process creation.",
    },
  ],
  [
    "scripts/gate/quality-gate-coordinator-socket.mjs",
    {
      rules: ["node-net-client"],
      reason:
        "This client only probes the private quality-gate coordinator socket and sends no process-launch request. The protocol cannot request external process creation.",
    },
  ],
  [
    "scripts/gate/quality-gate-coordinator.test.mjs",
    {
      rules: ["node-net-client"],
      reason:
        "This test uses temporary local quality-gate coordinator sockets. Its contained test protocol cannot request external process creation.",
    },
  ],
  [
    TEST_PATH,
    {
      rules: [
        "node-net-client",
        "node-net-dynamic-client",
        "javascript-process-broker",
      ],
      reason:
        "This executable test passes broker-shaped text only to the preflight scanner and uses no process broker. Its exact source hash requires a new capability review after any change.",
    },
  ],
]);

// A hash binds each exception to reviewed source bytes. A source change must
// update the exception after a new broker-capability review.
export const BROKER_CLIENT_ALLOWLIST = [
  {
    path: "scripts/gate/quality-gate-coordinator-client.mjs",
    rules: ["node-net-client"],
    sha256: "b210085e0a569e69fce5b1adf3cd613f41c0915a39975d5c5db9d445537b2b5b",
    reason: APPROVED_ALLOWLIST_SHAPE.get(
      "scripts/gate/quality-gate-coordinator-client.mjs",
    ).reason,
  },
  {
    path: "scripts/gate/quality-gate-coordinator-socket.mjs",
    rules: ["node-net-client"],
    sha256: "abd40b82e48df054fb7a49d26470003514d8d37ea10424656b9473c66c3923f3",
    reason: APPROVED_ALLOWLIST_SHAPE.get(
      "scripts/gate/quality-gate-coordinator-socket.mjs",
    ).reason,
  },
  {
    path: "scripts/gate/quality-gate-coordinator.test.mjs",
    rules: ["node-net-client"],
    sha256: "3d4b13b7f7738693d42dfa6fbb2a529f61ad0e18ae4a4f097d4dabfe048352ff",
    reason: APPROVED_ALLOWLIST_SHAPE.get(
      "scripts/gate/quality-gate-coordinator.test.mjs",
    ).reason,
  },
  {
    path: TEST_PATH,
    rules: [
      "node-net-client",
      "node-net-dynamic-client",
      "javascript-process-broker",
    ],
    sha256: "124d1ec6e53743d40d205e969ad7c9c50abc1571bd714bb92ad8ba1db5ac52e8",
    reason: APPROVED_ALLOWLIST_SHAPE.get(TEST_PATH).reason,
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceLanguage(path, source) {
  const extension = extname(path);
  if ([".sh", ".bash", ".zsh"].includes(extension)) return "shell";
  if ([".yaml", ".yml"].includes(extension)) return "workflow";
  if (extension === ".py") return "python";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if (extension === ".swift") return "swift";
  if ([".c", ".h", ".m", ".mm"].includes(extension)) return "native";
  if (/^#!.*\b(?:ba|z|k)?sh\b/mu.test(source)) return "shell";
  return "javascript";
}

function isExecutableSource(path, source) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return (
    SOURCE_EXTENSIONS.has(extname(path)) ||
    SOURCE_BASENAMES.has(basename) ||
    source.startsWith("#!")
  );
}

function isPackageManifest(path) {
  return path.slice(path.lastIndexOf("/") + 1) === PACKAGE_MANIFEST_BASENAME;
}

function isExcludedPath(path) {
  return (
    EXCLUDED_EXACT_PATHS.has(path) ||
    ROOT_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    path.split("/").some((part) => EXCLUDED_DIRECTORY_NAMES.has(part))
  );
}

function indexLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineForOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function addMatches(findings, path, source, lineStarts, rule, expression) {
  expression.lastIndex = 0;
  for (const match of source.matchAll(expression)) {
    findings.push({
      path,
      rule,
      line: lineForOffset(lineStarts, match.index),
      evidence: match[0].replace(/\s+/gu, " ").trim().slice(0, 180),
    });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function addNamedBrokerAliasCalls(
  findings,
  path,
  source,
  lineStarts,
  rule,
  alias,
  invocationSuffix,
) {
  if (!/^[A-Za-z_$][\w$]*$/u.test(alias)) return;
  addMatches(
    findings,
    path,
    source,
    lineStarts,
    rule,
    namedBrokerPattern(`\\b${escapeRegExp(alias)}${invocationSuffix}`),
  );
}

function scanJavaScriptProcessBrokerAliases(
  path,
  source,
  lineStarts,
  findings,
) {
  const processApis = new Set([
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "spawn",
    "spawnSync",
  ]);
  const namedImports =
    /(?:import\s*\{([^}]+)\}\s*from|(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\()\s*["'`](?:node:)?child_process["'`]/gmu;
  for (const match of source.matchAll(namedImports)) {
    for (const binding of (match[1] ?? match[2]).split(",")) {
      const parts = binding.trim().split(/(?:\s+as\s+|\s*:\s*)/u);
      if (!processApis.has(parts[0]) || parts.length !== 2) continue;
      addNamedBrokerAliasCalls(
        findings,
        path,
        source,
        lineStarts,
        "javascript-process-broker",
        parts[1].trim(),
        "\\s*\\(\\s*",
      );
    }
  }
}

function scanPythonProcessBrokerAliases(path, source, lineStarts, findings) {
  const processApis = new Map([
    ["os", new Set(["popen", "system"])],
    [
      "subprocess",
      new Set(["Popen", "call", "check_call", "check_output", "run"]),
    ],
  ]);
  const namedImports = /^\s*from\s+(os|subprocess)\s+import\s+([^#\n]+)/gmu;
  for (const match of source.matchAll(namedImports)) {
    for (const binding of match[2].replace(/[()]/gu, "").split(",")) {
      const parts = binding.trim().split(/\s+as\s+/u);
      if (!processApis.get(match[1]).has(parts[0]) || parts.length !== 2) {
        continue;
      }
      addNamedBrokerAliasCalls(
        findings,
        path,
        source,
        lineStarts,
        "python-process-broker",
        parts[1].trim(),
        "\\s*\\(\\s*(?:[[(]\\s*)?",
      );
    }
  }
}

function scanGoProcessBrokerAliases(path, source, lineStarts, findings) {
  const aliases =
    /\b(?:var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=)\s*[A-Za-z_][A-Za-z0-9_]*\s*\.\s*(Command|CommandContext)\b/gmu;
  for (const match of source.matchAll(aliases)) {
    const invocationSuffix =
      match[2] === "CommandContext"
        ? "\\s*\\(\\s*[^,\\n]+,\\s*"
        : "\\s*\\(\\s*";
    addNamedBrokerAliasCalls(
      findings,
      path,
      source,
      lineStarts,
      "go-process-broker",
      match[1],
      invocationSuffix,
    );
  }
}

function scanRustProcessBrokerAliases(path, source, lineStarts, findings) {
  const aliases =
    /\buse\s+(?:(?:std|tokio|async_std)\s*::\s*)?process\s*::\s*Command\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gmu;
  for (const match of source.matchAll(aliases)) {
    addNamedBrokerAliasCalls(
      findings,
      path,
      source,
      lineStarts,
      "rust-process-broker",
      match[1],
      "\\s*::\\s*new\\s*\\(\\s*",
    );
  }
}

function maskJavaScriptCommentsAndStrings(source) {
  let state = "code";
  let quote = "";
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        output += "  ";
        index += 1;
        state = "line-comment";
      } else if (char === "/" && next === "*") {
        output += "  ";
        index += 1;
        state = "block-comment";
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
        output += char;
        state = "string";
      } else {
        output += char;
      }
    } else if (state === "line-comment") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\n") state = "code";
    } else if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
    } else if (char === "\\") {
      output += "  ";
      index += 1;
    } else if (char === quote) {
      output += char;
      state = "code";
    } else {
      output += char === "\n" ? "\n" : " ";
    }
  }
  return output;
}

function scanNodeNet(path, source, lineStarts, findings) {
  const importsNet = source
    .split("\n")
    .some((line) => NODE_NET_MODULE.test(line));
  NODE_COMPUTED_CLIENT_CALL.lastIndex = 0;
  const importsClient =
    importsNet &&
    (NODE_CLIENT_SYMBOL.test(source) || NODE_COMPUTED_CLIENT_CALL.test(source));
  NODE_DYNAMIC_NET.lastIndex = 0;
  const dynamicNet = NODE_DYNAMIC_NET.test(source);
  if (!importsClient && !dynamicNet) return;
  const masked = maskJavaScriptCommentsAndStrings(source);
  const aliasNames = new Set();
  const namedImports =
    /(?:import\s*\{([^}]+)\}\s*from|(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\()\s*["'`](?:node:)?net["'`]/gmu;
  for (const match of source.matchAll(namedImports)) {
    for (const binding of (match[1] ?? match[2]).split(",")) {
      const parts = binding.trim().split(/(?:\s+as\s+|\s*:\s*)/u);
      if (["connect", "createConnection"].includes(parts[0])) {
        const alias = parts.at(-1).trim();
        if (!["connect", "createConnection"].includes(alias)) {
          aliasNames.add(alias);
        }
      }
    }
  }
  const memberAliases =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*(?:connect|createConnection)\b/gmu;
  for (const match of source.matchAll(memberAliases)) aliasNames.add(match[1]);
  NODE_CLIENT_CALL.lastIndex = 0;
  for (const match of masked.matchAll(NODE_CLIENT_CALL)) {
    const callPrefix = masked.slice(match.index, match.index + 100);
    // A numeric first argument selects TCP. It cannot reach a Unix-domain
    // process broker. Unknown and path-shaped arguments fail closed.
    if (/^connect\s*\(\s*(?:Number\s*\(|\d)/u.test(callPrefix)) continue;
    findings.push({
      path,
      rule: "node-net-client",
      line: lineForOffset(lineStarts, match.index),
      evidence: match[0].replace(/\s+/gu, " ").trim().slice(0, 180),
    });
  }
  addMatches(
    findings,
    path,
    source,
    lineStarts,
    "node-net-client",
    NODE_COMPUTED_CLIENT_CALL,
  );
  for (const alias of aliasNames) {
    const aliasCall = new RegExp(`\\b${alias}\\s*\\(`, "gmu");
    for (const match of masked.matchAll(aliasCall)) {
      const callPrefix = masked.slice(match.index, match.index + 100);
      if (/^[A-Za-z_$][\w$]*\s*\(\s*(?:Number\s*\(|\d)/u.test(callPrefix)) {
        continue;
      }
      findings.push({
        path,
        rule: "node-net-client",
        line: lineForOffset(lineStarts, match.index),
        evidence: match[0].trim(),
      });
    }
  }
  addMatches(
    findings,
    path,
    source,
    lineStarts,
    "node-net-client",
    NODE_TEMPLATE_CLIENT_CALL,
  );
  if (dynamicNet) {
    addMatches(
      findings,
      path,
      source,
      lineStarts,
      "node-net-dynamic-client",
      NODE_DYNAMIC_NET,
    );
  }
}

function scanPackageScripts(path, source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    return [
      {
        path,
        rule: "unscanned-package-scripts",
        line: 1,
        evidence: "package manifest is not valid JSON",
      },
    ];
  }
  if (
    manifest === null ||
    Array.isArray(manifest) ||
    typeof manifest !== "object"
  ) {
    return [
      {
        path,
        rule: "unscanned-package-scripts",
        line: 1,
        evidence: "package manifest is not a JSON object",
      },
    ];
  }
  if (manifest.scripts === undefined) return [];
  if (
    manifest.scripts === null ||
    Array.isArray(manifest.scripts) ||
    typeof manifest.scripts !== "object"
  ) {
    return [
      {
        path,
        rule: "unscanned-package-scripts",
        line: 1,
        evidence: "package scripts are not a JSON object",
      },
    ];
  }

  const findings = [];
  for (const [scriptName, command] of Object.entries(manifest.scripts)) {
    if (typeof command !== "string") {
      findings.push({
        path,
        rule: "unscanned-package-scripts",
        line: 1,
        evidence: `package script ${JSON.stringify(scriptName)} is not a string`,
      });
      continue;
    }
    const normalizedCommand = command.replace(
      /\$(?=["'])|\\(?:\r?\n)?|["']/gu,
      "",
    );
    if (
      command.includes("$'") ||
      PACKAGE_SCRIPT_SHELL_COMMAND_STRING.test(normalizedCommand) ||
      PACKAGE_SCRIPT_FISH_INIT_COMMAND_STRING.test(normalizedCommand)
    ) {
      findings.push({
        path,
        rule: "unscanned-package-scripts",
        line: 1,
        evidence: `package script ${JSON.stringify(scriptName)} uses shell syntax that broker admission cannot parse`,
      });
      continue;
    }
    for (const finding of scanSource(
      `${path}.agentqg-package-script.sh`,
      command,
    )) {
      findings.push({
        ...finding,
        path,
        line: 1,
        evidence:
          `script ${JSON.stringify(scriptName)}: ${finding.evidence}`.slice(
            0,
            180,
          ),
      });
    }
  }
  return findings;
}

export function scanSource(path, source) {
  if (isExcludedPath(path)) return [];
  if (isPackageManifest(path)) return scanPackageScripts(path, source);
  if (!isExecutableSource(path, source)) return [];
  const language = sourceLanguage(path, source);
  const lineStarts = indexLineStarts(source);
  const findings = [];
  if (language === "javascript") {
    scanNodeNet(path, source, lineStarts, findings);
    scanJavaScriptProcessBrokerAliases(path, source, lineStarts, findings);
  } else if (language === "python") {
    scanPythonProcessBrokerAliases(path, source, lineStarts, findings);
  } else if (language === "go") {
    scanGoProcessBrokerAliases(path, source, lineStarts, findings);
  } else if (language === "rust") {
    scanRustProcessBrokerAliases(path, source, lineStarts, findings);
  }
  for (const rule of RULES) {
    if (!rule.languages.has(language)) continue;
    for (const pattern of rule.patterns) {
      addMatches(findings, path, source, lineStarts, rule.id, pattern);
    }
  }
  return findings;
}

function normalizeRepoPath(root, absolutePath) {
  const path = relative(root, absolutePath).split(sep).join("/");
  if (!path || path === ".." || path.startsWith("../")) {
    throw new Error(`source path escapes repository root: ${absolutePath}`);
  }
  return path;
}

export function validateAllowlist(allowlist = BROKER_CLIENT_ALLOWLIST) {
  const errors = [];
  const seen = new Set();
  if (allowlist.length !== APPROVED_ALLOWLIST_SHAPE.size) {
    errors.push("allowlist entry count differs from the approved policy shape");
  }
  for (const entry of allowlist) {
    const approved = APPROVED_ALLOWLIST_SHAPE.get(entry.path);
    if (!approved) {
      errors.push(`unapproved allowlist path: ${entry.path}`);
      continue;
    }
    if (seen.has(entry.path))
      errors.push(`duplicate allowlist path: ${entry.path}`);
    seen.add(entry.path);
    if (
      entry.path.includes("*") ||
      entry.path.includes("?") ||
      entry.path.startsWith("/") ||
      entry.path.split("/").includes("..")
    ) {
      errors.push(`allowlist path is not exact: ${entry.path}`);
    }
    if (JSON.stringify(entry.rules) !== JSON.stringify(approved.rules)) {
      errors.push(`allowlist rules are broader or stale for ${entry.path}`);
    }
    if (entry.reason !== approved.reason) {
      errors.push(`allowlist reason is missing or changed for ${entry.path}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      errors.push(`allowlist source hash is malformed for ${entry.path}`);
    }
  }
  for (const path of APPROVED_ALLOWLIST_SHAPE.keys()) {
    if (!seen.has(path))
      errors.push(`approved allowlist path is missing: ${path}`);
  }
  return errors;
}

function gitListedPaths(root, args) {
  const output = execFileSync("/usr/bin/git", ["ls-files", "-z", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean);
}

function boundedGitOutput(root, args, label, maxBytes) {
  let output;
  try {
    output = execFileSync("/usr/bin/git", args, {
      cwd: root,
      maxBuffer: maxBytes + 1,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (output.length > maxBytes) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  return output;
}

function trustedMainlineBaseCommit(root) {
  const mainline = boundedGitOutput(
    root,
    ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
    "trusted origin/main commit",
    1024,
  )
    .toString("utf8")
    .trim();
  if (!GIT_OBJECT_ID.test(mainline)) {
    throw new Error("trusted origin/main did not resolve to one commit");
  }
  const mergeBases = boundedGitOutput(
    root,
    ["merge-base", "--all", "HEAD", mainline],
    "trusted mainline merge-base",
    4096,
  )
    .toString("utf8")
    .trim()
    .split(/\r?\n/gu)
    .filter(Boolean);
  if (mergeBases.length !== 1 || !GIT_OBJECT_ID.test(mergeBases[0])) {
    throw new Error("trusted mainline merge-base is not one commit");
  }
  return mergeBases[0];
}

function readTrustedGitBlob(root, commit, repoPath, label, maxBytes) {
  if (
    !GIT_OBJECT_ID.test(commit) ||
    !repoPath ||
    repoPath.startsWith("/") ||
    repoPath
      .split("/")
      .some(
        (part) =>
          !TERRAFORM_PACKAGE_ENTRY_SEGMENT.test(part) ||
          part === "." ||
          part === "..",
      )
  ) {
    throw new Error(`${label} has an unsafe Git object selector`);
  }
  return boundedGitOutput(
    root,
    ["cat-file", "blob", `${commit}:${repoPath}`],
    label,
    maxBytes,
  );
}

function listedRepoPaths(root) {
  const visible = gitListedPaths(root, [
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const ignored = gitListedPaths(root, [
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ".",
    ...IGNORED_PATH_EXCLUSIONS,
  ]);
  const paths = [...new Set([...visible, ...ignored])].sort();
  if (paths.length > MAX_REPOSITORY_PATHS) {
    throw new Error("repository path limit was exceeded");
  }
  return paths;
}

function hasExecutableMagic(bytes) {
  if (bytes.length < 4) return false;
  const magic = bytes.subarray(0, 4).toString("hex");
  return new Set([
    "7f454c46",
    "cafebabe",
    "cafebabf",
    "bebafeca",
    "bfbafeca",
    "cefaedfe",
    "cffaedfe",
    "feedface",
    "feedfacf",
  ]).has(magic);
}

function readMagic(path) {
  const buffer = Buffer.alloc(4);
  const descriptor = openSync(path, "r");
  try {
    return buffer.subarray(0, readSync(descriptor, buffer, 0, 4, 0));
  } finally {
    closeSync(descriptor);
  }
}

const STABLE_STAT_FIELDS = [
  "dev",
  "ino",
  "mode",
  "nlink",
  "uid",
  "gid",
  "size",
  "mtimeNs",
  "ctimeNs",
];

function sameStableStat(left, right) {
  return STABLE_STAT_FIELDS.every((field) => left[field] === right[field]);
}

function assertStableStat(before, after, label) {
  if (!sameStableStat(before, after)) {
    throw new Error(`${label} changed during provider attestation`);
  }
}

function readExactAt(descriptor, length, position, label) {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (count === 0) throw new Error(`${label} is truncated`);
    offset += count;
  }
  return bytes;
}

function machOCpuType(architecture) {
  if (architecture === "arm64") return 0x0100000c;
  if (architecture === "amd64") return 0x01000007;
  throw new Error("Terraform provider has an unsupported Mach-O architecture");
}

function machOUint32(bytes, offset, littleEndian) {
  return littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function parseThinMachO(
  descriptor,
  fileSize,
  sliceOffset,
  sliceSize,
  architecture,
) {
  const magic = readExactAt(
    descriptor,
    4,
    sliceOffset,
    "Terraform provider Mach-O header",
  ).readUInt32BE(0);
  let littleEndian;
  let headerSize;
  let is64Bit;
  if (magic === 0xfeedface) {
    littleEndian = false;
    headerSize = 28;
    is64Bit = false;
  } else if (magic === 0xcefaedfe) {
    littleEndian = true;
    headerSize = 28;
    is64Bit = false;
  } else if (magic === 0xfeedfacf) {
    littleEndian = false;
    headerSize = 32;
    is64Bit = true;
  } else if (magic === 0xcffaedfe) {
    littleEndian = true;
    headerSize = 32;
    is64Bit = true;
  } else {
    throw new Error("Terraform provider has no Mach-O header");
  }
  if (
    sliceOffset < 0 ||
    sliceSize < headerSize ||
    sliceOffset + sliceSize > fileSize
  ) {
    throw new Error("Terraform provider Mach-O slice is out of bounds");
  }
  const header = readExactAt(
    descriptor,
    headerSize,
    sliceOffset,
    "Terraform provider Mach-O header",
  );
  const cpuType = machOUint32(header, 4, littleEndian);
  const fileType = machOUint32(header, 12, littleEndian);
  const commandCount = machOUint32(header, 16, littleEndian);
  const commandBytes = machOUint32(header, 20, littleEndian);
  if (!is64Bit || cpuType !== machOCpuType(architecture)) {
    throw new Error(
      "Terraform provider Mach-O CPU does not match the gate host",
    );
  }
  if (fileType !== 2 || commandCount === 0 || commandCount > 4096) {
    throw new Error("Terraform provider Mach-O executable header is invalid");
  }
  if (
    commandBytes < commandCount * 8 ||
    commandBytes > MAX_MACH_O_LOAD_COMMAND_BYTES ||
    headerSize + commandBytes > sliceSize
  ) {
    throw new Error(
      "Terraform provider Mach-O load commands are out of bounds",
    );
  }
  const commands = readExactAt(
    descriptor,
    commandBytes,
    sliceOffset + headerSize,
    "Terraform provider Mach-O load commands",
  );
  let cursor = 0;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commands.length) {
      throw new Error("Terraform provider Mach-O load commands are truncated");
    }
    const size = machOUint32(commands, cursor + 4, littleEndian);
    if (size < 8 || size % 4 !== 0 || cursor + size > commands.length) {
      throw new Error("Terraform provider Mach-O load command is invalid");
    }
    cursor += size;
  }
  if (cursor !== commands.length) {
    throw new Error(
      "Terraform provider Mach-O load command size is inconsistent",
    );
  }
}

function validateMachO(descriptor, size, architecture) {
  const fileSize = Number(size);
  const magicBytes = readExactAt(
    descriptor,
    4,
    0,
    "Terraform provider Mach-O header",
  );
  const magic = magicBytes.readUInt32BE(0);
  if (
    magic === 0xfeedface ||
    magic === 0xcefaedfe ||
    magic === 0xfeedfacf ||
    magic === 0xcffaedfe
  ) {
    parseThinMachO(descriptor, fileSize, 0, fileSize, architecture);
    return;
  }

  let littleEndian;
  let entrySize;
  if (magic === 0xcafebabe) {
    littleEndian = false;
    entrySize = 20;
  } else if (magic === 0xbebafeca) {
    littleEndian = true;
    entrySize = 20;
  } else if (magic === 0xcafebabf) {
    littleEndian = false;
    entrySize = 32;
  } else if (magic === 0xbfbafeca) {
    littleEndian = true;
    entrySize = 32;
  } else {
    throw new Error("Terraform provider has no Mach-O header");
  }
  const header = readExactAt(
    descriptor,
    8,
    0,
    "Terraform provider fat Mach-O header",
  );
  const architectureCount = machOUint32(header, 4, littleEndian);
  if (
    architectureCount === 0 ||
    architectureCount > MAX_FAT_MACH_O_ARCHITECTURES
  ) {
    throw new Error(
      "Terraform provider fat Mach-O architecture count is invalid",
    );
  }
  const architectureBytes = readExactAt(
    descriptor,
    architectureCount * entrySize,
    8,
    "Terraform provider fat Mach-O architecture table",
  );
  const tableEnd = 8 + architectureBytes.length;
  const slices = [];
  for (let index = 0; index < architectureCount; index += 1) {
    const cursor = index * entrySize;
    const cpuType = machOUint32(architectureBytes, cursor, littleEndian);
    let offset;
    let sliceSize;
    if (entrySize === 20) {
      offset = machOUint32(architectureBytes, cursor + 8, littleEndian);
      sliceSize = machOUint32(architectureBytes, cursor + 12, littleEndian);
    } else {
      const offsetValue = littleEndian
        ? architectureBytes.readBigUInt64LE(cursor + 8)
        : architectureBytes.readBigUInt64BE(cursor + 8);
      const sizeValue = littleEndian
        ? architectureBytes.readBigUInt64LE(cursor + 16)
        : architectureBytes.readBigUInt64BE(cursor + 16);
      if (
        offsetValue > BigInt(Number.MAX_SAFE_INTEGER) ||
        sizeValue > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new Error("Terraform provider fat Mach-O slice is too large");
      }
      offset = Number(offsetValue);
      sliceSize = Number(sizeValue);
    }
    const align = machOUint32(
      architectureBytes,
      cursor + (entrySize === 20 ? 16 : 24),
      littleEndian,
    );
    if (
      align > 31 ||
      offset < tableEnd ||
      sliceSize < 28 ||
      offset + sliceSize > fileSize ||
      offset % 2 ** align !== 0
    ) {
      throw new Error("Terraform provider fat Mach-O slice is out of bounds");
    }
    slices.push({ cpuType, offset, sliceSize });
  }
  const ordered = [...slices].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < ordered.length; index += 1) {
    if (
      ordered[index - 1].offset + ordered[index - 1].sliceSize >
      ordered[index].offset
    ) {
      throw new Error("Terraform provider fat Mach-O slices overlap");
    }
  }
  const currentSlices = slices.filter(
    (slice) => slice.cpuType === machOCpuType(architecture),
  );
  if (currentSlices.length !== 1) {
    throw new Error(
      "Terraform provider fat Mach-O has no unique current CPU slice",
    );
  }
  parseThinMachO(
    descriptor,
    fileSize,
    currentSlices[0].offset,
    currentSlices[0].sliceSize,
    architecture,
  );
}

function terraformArchitecture(architecture) {
  if (architecture === "arm64") return "arm64";
  if (architecture === "x64") return "amd64";
  return undefined;
}

function terraformProviderCandidate(path, platformName, architecture) {
  if (platformName !== "darwin") return undefined;
  const terraformArch = terraformArchitecture(architecture);
  if (!terraformArch) return undefined;
  const parts = path.split("/");
  const dataDirectoryIndex = parts.indexOf(".terraform-agent-gate");
  if (
    dataDirectoryIndex < 0 ||
    parts.lastIndexOf(".terraform-agent-gate") !== dataDirectoryIndex ||
    parts.length < dataDirectoryIndex + 8 ||
    parts[dataDirectoryIndex + 1] !== "providers" ||
    parts[dataDirectoryIndex + 2] !== "registry.terraform.io"
  ) {
    return undefined;
  }
  const namespace = parts[dataDirectoryIndex + 3];
  const type = parts[dataDirectoryIndex + 4];
  const version = parts[dataDirectoryIndex + 5];
  const target = parts[dataDirectoryIndex + 6];
  const memberParts = parts.slice(dataDirectoryIndex + 7);
  if (
    !TERRAFORM_PROVIDER_SEGMENT.test(namespace) ||
    !TERRAFORM_PROVIDER_SEGMENT.test(type) ||
    !TERRAFORM_PROVIDER_VERSION.test(version) ||
    target !== `darwin_${terraformArch}` ||
    memberParts.length === 0 ||
    memberParts.some(
      (part) =>
        !TERRAFORM_PACKAGE_ENTRY_SEGMENT.test(part) ||
        part === "." ||
        part === "..",
    )
  ) {
    return undefined;
  }
  return {
    architecture: terraformArch,
    dataDirectoryPath: parts.slice(0, dataDirectoryIndex + 1).join("/"),
    packagePath: parts.slice(0, dataDirectoryIndex + 7).join("/"),
    sourceAddress: `registry.terraform.io/${namespace}/${type}`,
    type,
    version,
  };
}

function readStableRegularFile(path, label, maxBytes) {
  const pathStat = lstatSync(path, { bigint: true });
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.nlink !== 1n ||
    (pathStat.mode & 0o7000n) !== 0n
  ) {
    throw new Error(`${label} is not a safe single-link regular file`);
  }
  if (pathStat.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error(`${label} changed type before it was read`);
    }
    assertStableStat(pathStat, before, label);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    assertStableStat(before, after, label);
    const finalPathStat = lstatSync(path, { bigint: true });
    assertStableStat(after, finalPathStat, label);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function packageDirectorySnapshot(packageDirectory) {
  const directories = [];
  const files = [];
  let totalBytes = 0;

  function visit(directory, relativeDirectory) {
    const stat = lstatSync(directory, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o7000n) !== 0n
    ) {
      throw new Error(
        "Terraform provider package contains an unsafe directory",
      );
    }
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) =>
        Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    );
    if (
      entries.some(
        (entry) =>
          !TERRAFORM_PACKAGE_ENTRY_SEGMENT.test(entry.name) ||
          entry.name === "." ||
          entry.name === "..",
      )
    ) {
      throw new Error(
        "Terraform provider package contains an unsafe path segment",
      );
    }
    directories.push({
      path: relativeDirectory,
      stat,
      entries: entries.map(
        (entry) =>
          `${entry.name}:${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "o"}`,
      ),
    });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      const fileStat = lstatSync(absolutePath, { bigint: true });
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        fileStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        fileStat.nlink !== 1n ||
        (fileStat.mode & 0o7000n) !== 0n
      ) {
        throw new Error("Terraform provider package contains an unsafe file");
      }
      if (fileStat.size > BigInt(MAX_TERRAFORM_PROVIDER_FILE_BYTES)) {
        throw new Error(
          "Terraform provider package file exceeds its byte limit",
        );
      }
      totalBytes += Number(fileStat.size);
      if (totalBytes > MAX_TERRAFORM_PROVIDER_TOTAL_BYTES) {
        throw new Error("Terraform provider package exceeds its byte limit");
      }
      files.push({ absolutePath, relativePath, stat: fileStat });
      if (files.length > MAX_TERRAFORM_PROVIDER_FILES) {
        throw new Error("Terraform provider package exceeds its file limit");
      }
    }
  }

  visit(packageDirectory, "");
  files.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath),
      Buffer.from(right.relativePath),
    ),
  );
  directories.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  return { directories, files, totalBytes };
}

function safeDirectoryAncestrySnapshot(root, target) {
  const path = relative(root, target);
  if (!path || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("Terraform provider package escapes the repository root");
  }
  let cursor = root;
  const ancestry = [];
  for (const segment of path.split(sep)) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o7000n) !== 0n
    ) {
      throw new Error(
        "Terraform provider package has unsafe directory ancestry",
      );
    }
    ancestry.push({ path: cursor, stat });
  }
  return ancestry;
}

function assertSameDirectoryAncestry(before, after) {
  if (before.length !== after.length) {
    throw new Error("Terraform provider directory ancestry changed");
  }
  for (let index = 0; index < before.length; index += 1) {
    if (before[index].path !== after[index].path) {
      throw new Error("Terraform provider directory ancestry changed");
    }
    assertStableStat(
      before[index].stat,
      after[index].stat,
      "Terraform provider directory ancestry",
    );
  }
}

function assertSamePackageSnapshot(before, after) {
  if (
    before.totalBytes !== after.totalBytes ||
    before.files.length !== after.files.length ||
    before.directories.length !== after.directories.length
  ) {
    throw new Error("Terraform provider package changed during attestation");
  }
  for (let index = 0; index < before.directories.length; index += 1) {
    const first = before.directories[index];
    const second = after.directories[index];
    if (
      first.path !== second.path ||
      JSON.stringify(first.entries) !== JSON.stringify(second.entries)
    ) {
      throw new Error(
        "Terraform provider package entries changed during attestation",
      );
    }
    assertStableStat(first.stat, second.stat, "Terraform provider directory");
  }
  for (let index = 0; index < before.files.length; index += 1) {
    const first = before.files[index];
    const second = after.files[index];
    if (first.relativePath !== second.relativePath) {
      throw new Error(
        "Terraform provider package files changed during attestation",
      );
    }
    assertStableStat(first.stat, second.stat, "Terraform provider file");
  }
}

function hashStableProviderFile(file, machOArchitecture) {
  const descriptor = openSync(
    file.absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error("Terraform provider package file changed type");
    }
    assertStableStat(file.stat, before, "Terraform provider file");
    const hash = createHash("sha256");
    const magic = Buffer.alloc(4);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      if (offset < magic.length) {
        buffer.copy(magic, offset, 0, Math.min(read, magic.length - offset));
      }
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    if (BigInt(offset) !== before.size) {
      throw new Error(
        "Terraform provider package file changed size while read",
      );
    }
    if (machOArchitecture) {
      validateMachO(descriptor, before.size, machOArchitecture);
    }
    const after = fstatSync(descriptor, { bigint: true });
    assertStableStat(before, after, "Terraform provider file");
    return {
      digest: hash.digest("hex"),
      magic,
      validatedMachO: Boolean(machOArchitecture),
    };
  } finally {
    closeSync(descriptor);
  }
}

function parseTerraformLockfile(source) {
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const providers = new Map();
  let index = 0;
  const skipTrivia = () => {
    while (index < lines.length && /^(?:\s*|\s*#.*)$/u.test(lines[index])) {
      index += 1;
    }
  };
  skipTrivia();
  while (index < lines.length) {
    const header =
      /^provider "([a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+)" \{$/u.exec(
        lines[index],
      );
    if (!header) throw new Error("Terraform dependency lock file is malformed");
    const address = header[1];
    if (providers.has(address)) {
      throw new Error(
        `Terraform dependency lock has duplicate ${address} blocks`,
      );
    }
    index += 1;
    let version;
    let hashes;
    let sawConstraints = false;
    while (index < lines.length && lines[index] !== "}") {
      if (/^\s*$/u.test(lines[index])) {
        index += 1;
        continue;
      }
      const versionMatch = /^\s{2}version\s+=\s+"([^"]+)"$/u.exec(lines[index]);
      if (versionMatch && version === undefined) {
        version = versionMatch[1];
        index += 1;
        continue;
      }
      if (
        /^\s{2}constraints\s+=\s+"[^"]+"$/u.test(lines[index]) &&
        !sawConstraints
      ) {
        sawConstraints = true;
        index += 1;
        continue;
      }
      if (
        /^\s{2}hashes\s+=\s+\[$/u.test(lines[index]) &&
        hashes === undefined
      ) {
        hashes = [];
        index += 1;
        while (index < lines.length && lines[index] !== "  ]") {
          const hashMatch = /^\s{4}"([a-z0-9]+:[A-Za-z0-9+/=]+)",?$/u.exec(
            lines[index],
          );
          if (!hashMatch) {
            throw new Error("Terraform dependency lock hash list is malformed");
          }
          hashes.push(hashMatch[1]);
          index += 1;
        }
        if (lines[index] !== "  ]") {
          throw new Error(
            "Terraform dependency lock hash list is unterminated",
          );
        }
        index += 1;
        continue;
      }
      throw new Error("Terraform dependency lock provider block is malformed");
    }
    if (
      lines[index] !== "}" ||
      !TERRAFORM_PROVIDER_VERSION.test(version ?? "") ||
      !hashes ||
      hashes.length === 0 ||
      new Set(hashes).size !== hashes.length
    ) {
      throw new Error("Terraform dependency lock provider block is incomplete");
    }
    providers.set(address, { version, hashes });
    index += 1;
    skipTrivia();
  }
  return providers;
}

function nearestTrackedTerraformLock(root, dataDirectory, trackedPaths) {
  let cursor = dataDirectory;
  for (;;) {
    const candidate = join(cursor, ".terraform.lock.hcl");
    let exists = false;
    try {
      lstatSync(candidate);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exists) {
      const repoPath = normalizeRepoPath(root, candidate);
      if (!trackedPaths.has(repoPath)) {
        throw new Error(
          `Terraform dependency lock is not tracked: ${repoPath}`,
        );
      }
      return { absolutePath: candidate, repoPath };
    }
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor || relative(root, parent).startsWith(`..${sep}`))
      break;
    cursor = parent;
  }
  throw new Error("Terraform provider package has no tracked dependency lock");
}

function parseTerraformStackRegistry(source) {
  let registry;
  try {
    registry = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("Terraform stack registry is malformed");
  }
  if (
    registry === null ||
    typeof registry !== "object" ||
    registry.version !== 1 ||
    !Array.isArray(registry.stacks) ||
    registry.stacks.length === 0 ||
    registry.stacks.length > 64
  ) {
    throw new Error("Terraform stack registry has an unsupported shape");
  }
  const paths = registry.stacks.map((stack) => stack?.path);
  if (
    paths.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        path.startsWith("/") ||
        path
          .split("/")
          .some(
            (part) =>
              !TERRAFORM_PACKAGE_ENTRY_SEGMENT.test(part) ||
              part === "." ||
              part === "..",
          ),
    ) ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error("Terraform stack registry contains an unsafe stack path");
  }
  return paths;
}

function trustedTerraformPolicy(root, trackedPaths) {
  const registryPath = "terraform.stacks.json";
  if (!trackedPaths.has(registryPath)) {
    throw new Error("Terraform stack registry is not tracked");
  }
  const baseCommit = trustedMainlineBaseCommit(root);
  const trustedRegistry = readTrustedGitBlob(
    root,
    baseCommit,
    registryPath,
    "trusted Terraform stack registry",
    MAX_TERRAFORM_STACK_REGISTRY_BYTES,
  );
  assertWorktreeMatchesTrustedBlob(
    resolve(root, registryPath),
    "Terraform stack registry",
    trustedRegistry,
    MAX_TERRAFORM_STACK_REGISTRY_BYTES,
  );
  return {
    baseCommit,
    registryPath,
    stackPaths: parseTerraformStackRegistry(trustedRegistry),
    trustedRegistry,
  };
}

function assertWorktreeMatchesTrustedBlob(
  absolutePath,
  label,
  trustedBytes,
  maxBytes,
) {
  const worktreeBytes = readStableRegularFile(absolutePath, label, maxBytes);
  if (!worktreeBytes.equals(trustedBytes)) {
    throw new Error(`${label} differs from its trusted mainline blob`);
  }
}

function attestTerraformProviderPackage(
  root,
  candidate,
  trackedPaths,
  terraformPolicy,
  providerPackageHashHook,
) {
  const packageDirectory = resolve(root, candidate.packagePath);
  const dataDirectory = resolve(root, candidate.dataDirectoryPath);
  const ancestryBefore = safeDirectoryAncestrySnapshot(root, packageDirectory);
  const lock = nearestTrackedTerraformLock(root, dataDirectory, trackedPaths);
  const owningStack = terraformPolicy.stackPaths.find((stackPath) =>
    [
      `${stackPath}/.terraform-agent-gate`,
      `${stackPath}/${stackPath}/.terraform-agent-gate`,
    ].includes(candidate.dataDirectoryPath),
  );
  if (!owningStack || lock.repoPath !== `${owningStack}/.terraform.lock.hcl`) {
    throw new Error(
      "Terraform provider package is outside a registered stack data directory",
    );
  }
  const trustedLockSource = readTrustedGitBlob(
    root,
    terraformPolicy.baseCommit,
    lock.repoPath,
    "trusted Terraform dependency lock",
    MAX_TERRAFORM_LOCK_BYTES,
  );
  assertWorktreeMatchesTrustedBlob(
    lock.absolutePath,
    "Terraform dependency lock",
    trustedLockSource,
    MAX_TERRAFORM_LOCK_BYTES,
  );
  const lockEntry = parseTerraformLockfile(
    trustedLockSource.toString("utf8"),
  ).get(candidate.sourceAddress);
  if (!lockEntry || lockEntry.version !== candidate.version) {
    throw new Error(
      `Terraform dependency lock does not select ${candidate.sourceAddress} ${candidate.version}`,
    );
  }

  const before = packageDirectorySnapshot(packageDirectory);
  const expectedExecutable = new RegExp(
    `^terraform-provider-${escapeRegExp(candidate.type)}_v${escapeRegExp(candidate.version)}(?:_x[0-9]+)?$`,
    "u",
  );
  const executableFiles = before.files.filter(
    (file) =>
      !file.relativePath.includes("/") &&
      expectedExecutable.test(file.relativePath),
  );
  if (executableFiles.length !== 1) {
    throw new Error(
      "Terraform provider package must contain one exact executable",
    );
  }

  const packageHash = createHash("sha256");
  let executableMachO = false;
  for (const file of before.files) {
    const isProviderExecutable = file === executableFiles[0];
    const hashed = hashStableProviderFile(
      file,
      isProviderExecutable ? candidate.architecture : undefined,
    );
    packageHash.update(`${hashed.digest}  ${file.relativePath}\n`);
    if (isProviderExecutable) {
      executableMachO = hashed.validatedMachO;
    } else if (
      (file.stat.mode & 0o111n) !== 0n ||
      hasExecutableMagic(hashed.magic)
    ) {
      throw new Error(
        "Terraform provider package contains an additional opaque executable",
      );
    }
  }
  const h1 = `h1:${packageHash.digest("base64")}`;
  providerPackageHashHook?.({
    packageDirectory,
    packagePath: candidate.packagePath,
    executablePath: executableFiles[0].absolutePath,
  });
  const after = packageDirectorySnapshot(packageDirectory);
  assertSamePackageSnapshot(before, after);
  const ancestryAfter = safeDirectoryAncestrySnapshot(root, packageDirectory);
  assertSameDirectoryAncestry(ancestryBefore, ancestryAfter);
  assertWorktreeMatchesTrustedBlob(
    lock.absolutePath,
    "Terraform dependency lock",
    trustedLockSource,
    MAX_TERRAFORM_LOCK_BYTES,
  );
  assertWorktreeMatchesTrustedBlob(
    resolve(root, terraformPolicy.registryPath),
    "Terraform stack registry",
    terraformPolicy.trustedRegistry,
    MAX_TERRAFORM_STACK_REGISTRY_BYTES,
  );
  if (!executableMachO || (executableFiles[0].stat.mode & 0o111n) === 0n) {
    throw new Error(
      "Terraform provider executable is not an executable Mach-O file",
    );
  }
  if (!lockEntry.hashes.includes(h1)) {
    throw new Error(
      `Terraform provider package h1 checksum is absent from ${lock.repoPath}`,
    );
  }
  return {
    path: `${candidate.packagePath}/${executableFiles[0].relativePath}`,
    rule: "attested-terraform-provider",
    line: 1,
    evidence: `${candidate.sourceAddress} ${candidate.version} matches ${h1}`,
    totalBytes: before.totalBytes,
  };
}

export function scanRepository(
  root,
  {
    allowlist = BROKER_CLIENT_ALLOWLIST,
    paths = listedRepoPaths(root),
    policyRoot = root,
    trackedPaths,
    platformName = process.platform,
    architecture = process.arch,
    providerPackageHashHook,
  } = {},
) {
  const policyErrors = validateAllowlist(allowlist);
  const findings = [];
  const attestedProviders = [];
  const providerPackages = new Set();
  const sources = new Map();
  const normalizedPaths = new Set(
    paths.map((listedPath) =>
      normalizeRepoPath(root, resolve(root, listedPath)),
    ),
  );
  let totalSourceBytes = 0;
  let totalTerraformProviderBytes = 0;
  let trackedRepoPaths;
  let terraformPolicy;
  let terraformPolicyError;
  for (const path of [...normalizedPaths].sort()) {
    const absolutePath = resolve(root, path);
    if (isExcludedPath(path)) continue;
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const providerCandidate = terraformProviderCandidate(
      path,
      platformName,
      architecture,
    );
    if (providerCandidate) {
      if (!providerPackages.has(providerCandidate.packagePath)) {
        providerPackages.add(providerCandidate.packagePath);
        try {
          trackedRepoPaths ??= new Set(
            (trackedPaths ?? gitListedPaths(root, ["--cached"])).map(
              (trackedPath) =>
                normalizeRepoPath(root, resolve(root, trackedPath)),
            ),
          );
          if (terraformPolicyError) throw terraformPolicyError;
          if (!terraformPolicy) {
            try {
              terraformPolicy = trustedTerraformPolicy(root, trackedRepoPaths);
            } catch (error) {
              terraformPolicyError = error;
              throw error;
            }
          }
          const attestation = attestTerraformProviderPackage(
            root,
            providerCandidate,
            trackedRepoPaths,
            terraformPolicy,
            providerPackageHashHook,
          );
          totalTerraformProviderBytes += attestation.totalBytes;
          if (
            totalTerraformProviderBytes > MAX_TERRAFORM_PROVIDER_TOTAL_BYTES
          ) {
            throw new Error(
              "Terraform provider packages exceed their aggregate byte limit",
            );
          }
          attestedProviders.push(attestation);
        } catch (error) {
          findings.push({
            path: providerCandidate.packagePath,
            rule: "unattested-terraform-provider",
            line: 1,
            evidence: error.message.replace(/\s+/gu, " ").trim().slice(0, 180),
          });
        }
      }
      continue;
    }
    if (stat.isSymbolicLink()) {
      if (isPackageManifest(path)) {
        findings.push({
          path,
          rule: "unscanned-package-scripts",
          line: 1,
          evidence:
            "package manifest is a symlink and cannot be scanned safely",
        });
        continue;
      }
      let targetPath;
      try {
        targetPath = normalizeRepoPath(root, realpathSync(absolutePath));
      } catch (error) {
        findings.push({
          path,
          rule: "unscanned-source-symlink",
          line: 1,
          evidence: `symlink target is unavailable or outside the repository: ${error.code ?? error.message}`,
        });
        continue;
      }
      const targetStat = lstatSync(resolve(root, targetPath));
      if (
        !normalizedPaths.has(targetPath) ||
        isExcludedPath(targetPath) ||
        !targetStat.isFile() ||
        targetStat.isSymbolicLink()
      ) {
        findings.push({
          path,
          rule: "unscanned-source-symlink",
          line: 1,
          evidence: `symlink target is not an enumerated repository source: ${targetPath}`,
        });
      }
      continue;
    }
    if (!stat.isFile()) continue;
    const magic = readMagic(absolutePath);
    if (hasExecutableMagic(magic)) {
      findings.push({
        path,
        rule: "opaque-executable",
        line: 1,
        evidence: "native executable bytes have no inspectable source contract",
      });
      continue;
    }
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const sourceShaped =
      SOURCE_EXTENSIONS.has(extname(path)) ||
      SOURCE_BASENAMES.has(basename) ||
      basename === PACKAGE_MANIFEST_BASENAME;
    if (stat.size > MAX_SOURCE_BYTES) {
      if (sourceShaped || (stat.mode & 0o111) !== 0) {
        findings.push({
          path,
          rule: "oversized-executable-source",
          line: 1,
          evidence: `source exceeds the ${MAX_SOURCE_BYTES}-byte inspection limit`,
        });
      }
      continue;
    }
    const sourceBytes = readFileSync(absolutePath);
    const source = sourceBytes.toString("utf8");
    const executableSource = isExecutableSource(path, source);
    const recognizedSource = executableSource || isPackageManifest(path);
    if (
      (stat.mode & 0o111) !== 0 &&
      (!executableSource || sourceBytes.includes(0))
    ) {
      findings.push({
        path,
        rule: "opaque-executable",
        line: 1,
        evidence: "executable bytes have no inspectable source contract",
      });
      continue;
    }
    if (!recognizedSource) continue;
    totalSourceBytes += sourceBytes.length;
    if (totalSourceBytes > MAX_TOTAL_SOURCE_BYTES) {
      throw new Error("repository source byte limit was exceeded");
    }
    sources.set(path, source);
    findings.push(...scanSource(path, source));
  }

  const allowByPath = new Map(allowlist.map((entry) => [entry.path, entry]));
  const policySources = new Map();
  for (const entry of allowlist) {
    const absolutePath = resolve(policyRoot, entry.path);
    const normalizedPath = normalizeRepoPath(policyRoot, absolutePath);
    if (normalizedPath !== entry.path) {
      policyErrors.push(
        `allowlist path does not resolve exactly: ${entry.path}`,
      );
      continue;
    }
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        policyErrors.push(
          `allowlisted policy source is missing: ${entry.path}`,
        );
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      policyErrors.push(
        `allowlisted policy source is not a regular file: ${entry.path}`,
      );
      continue;
    }
    const source = readFileSync(absolutePath, "utf8");
    policySources.set(entry.path, source);
    if (sha256(source) !== entry.sha256) {
      policyErrors.push(
        `allowlisted policy source hash is stale: ${entry.path}`,
      );
    }
    const matching = scanSource(entry.path, source).some((finding) =>
      entry.rules.includes(finding.rule),
    );
    if (!matching) {
      policyErrors.push(
        `allowlisted broker capability is stale: ${entry.path}`,
      );
    }
  }
  const rejected = [];
  const accepted = [];
  for (const finding of findings) {
    const entry = allowByPath.get(finding.path);
    const source = sources.get(finding.path);
    const approvedSource = policySources.get(finding.path);
    if (
      entry &&
      entry.rules.includes(finding.rule) &&
      source !== undefined &&
      approvedSource !== undefined &&
      sha256(source) === entry.sha256 &&
      sha256(approvedSource) === entry.sha256
    ) {
      accepted.push(finding);
    } else {
      rejected.push(finding);
    }
  }
  return {
    accepted: [...attestedProviders, ...accepted],
    rejected,
    policyErrors: [...new Set(policyErrors)],
  };
}

function printFailure(result) {
  for (const error of result.policyErrors) {
    console.error(`error: Darwin broker preflight policy: ${error}`);
  }
  for (const finding of result.rejected) {
    console.error(
      `error: Darwin broker preflight rejected ${finding.path}:${finding.line} (${finding.rule}): ${finding.evidence}`,
    );
  }
  console.error(
    "error: mapped commands did not start because broker-mediated process creation cannot be contained by Darwin lineage tracking.",
  );
}

export function runDarwinBrokerPreflight(rootInput, policyRootInput) {
  const root = resolve(rootInput ?? process.cwd());
  const policyRoot = resolve(policyRootInput ?? root);
  let result;
  try {
    result = scanRepository(root, { policyRoot });
  } catch (error) {
    console.error(
      `error: Darwin broker preflight could not scan source: ${error.message}`,
    );
    return 2;
  }
  if (result.policyErrors.length > 0 || result.rejected.length > 0) {
    printFailure(result);
    return 2;
  }
  return 0;
}

function main() {
  return runDarwinBrokerPreflight(process.argv[2], process.argv[3]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (
  import.meta.url.startsWith("file:") &&
  invokedPath === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
