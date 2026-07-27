import { load as loadYaml } from "js-yaml";
import {
  isMapping,
  stripShellComment,
} from "./production-infra-identity-contract/workflow-inventory.mjs";

const GCLOUD_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "--account",
  "--billing-project",
  "--configuration",
  "--flags-file",
  "--flatten",
  "--format",
  "--impersonate-service-account",
  "--project",
  "--trace-token",
  "--verbosity",
]);

const SHELL_FILE_EXTENSIONS = [
  ".bash",
  ".command",
  ".fish",
  ".ksh",
  ".sh",
  ".zsh",
];
const SHELL_COMMAND_BOUNDARIES = new Set(["(", ")", ";", "&&", "||", "|", "&"]);
const SHELL_COMMAND_PREFIXES = new Set([
  "!",
  "command",
  "do",
  "elif",
  "else",
  "env",
  "if",
  "then",
  "until",
  "while",
]);
const SHELL_COMMAND_WRAPPERS = new Set(["command", "env", "exec", "time"]);
const SHELL_EXECUTABLES = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const DEPLOY_COMMAND_PATTERN =
  /\bgcloud(?:(?:\s+--[^\s]+)|(?:\s+(?:alpha|beta))|(?:\s+(?!(?:builds|app)\b)[^\s]+))*\s+(?:builds\s+submit|app\s+deploy)\b/u;

function shellCommands(contents) {
  const commands = [];
  let pending = "";
  for (const line of contents.split(/\r?\n/u)) {
    const code = stripShellComment(line).trim();
    if (!code && !pending) continue;
    const continued = code.endsWith("\\");
    const segment = continued ? code.slice(0, -1).trimEnd() : code;
    pending = `${pending} ${segment}`.trim();
    if (!continued && pending) {
      commands.push(pending.replace(/\s+/gu, " "));
      pending = "";
    }
  }
  if (pending) commands.push(pending.replace(/\s+/gu, " "));
  return commands;
}

function shellTokens(command) {
  const tokens = [];
  let token = "";
  let quote;
  let escaped = false;
  const flush = () => {
    if (token) tokens.push(token);
    token = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (character === "(" && command[index - 1] === "$") {
      token += character;
      continue;
    }
    if (
      character === "(" ||
      character === ")" ||
      character === ";" ||
      character === "|" ||
      character === "&"
    ) {
      flush();
      const next = command[index + 1];
      if (next === character && (character === "|" || character === "&")) {
        tokens.push(`${character}${next}`);
        index += 1;
      } else {
        tokens.push(character);
      }
      continue;
    }
    token += character;
  }
  flush();
  return tokens;
}

function isAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token);
}

function wrappedCommandIndex(tokens, index) {
  let commandIndex = index + 1;
  const wrapper = tokens[index];
  if (wrapper === "command") {
    let lookupOnly = false;
    while (/^-[pVv]+$/u.test(tokens[commandIndex])) {
      lookupOnly ||= /[vV]/u.test(tokens[commandIndex]);
      commandIndex += 1;
    }
    if (lookupOnly) return null;
    if (tokens[commandIndex] === "--") commandIndex += 1;
  } else if (wrapper === "env") {
    while (tokens[commandIndex]?.startsWith("-")) {
      const option = tokens[commandIndex];
      if (option === "--") {
        commandIndex += 1;
        break;
      }
      if (option === "-i" || option === "--ignore-environment") {
        commandIndex += 1;
      } else if (/^-(?:[uC].+|-(?:unset|chdir)=.+)$/u.test(option)) {
        commandIndex += 1;
      } else if (["-u", "-C", "--unset", "--chdir"].includes(option)) {
        if (commandIndex + 1 >= tokens.length) return undefined;
        commandIndex += 2;
      } else {
        return undefined;
      }
    }
    while (isAssignment(tokens[commandIndex])) commandIndex += 1;
  } else if (wrapper === "exec") {
    while (
      /^-[cl]+$/u.test(tokens[commandIndex]) ||
      tokens[commandIndex] === "-a"
    ) {
      commandIndex += tokens[commandIndex] === "-a" ? 2 : 1;
    }
  } else if (tokens[commandIndex] === "-p") {
    commandIndex += 1;
  }
  return tokens[commandIndex]?.startsWith("-") ? undefined : commandIndex;
}

function shellFilePath(filePath) {
  return SHELL_FILE_EXTENSIONS.some((extension) =>
    filePath.endsWith(extension),
  );
}

function isShellScript(filePath, contents) {
  return (
    shellFilePath(filePath) ||
    /^#!.*\b(?:bash|dash|fish|ksh|sh|zsh)\b/u.test(contents)
  );
}

function commandSubstitutions(command) {
  const substitutions = [];
  let quote;
  let substitution;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (substitution) {
      if (substitution.quote) {
        if (character === substitution.quote) {
          substitution.quote = undefined;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        substitution.quote = character;
        continue;
      }
      if (character === "$") {
        if (command[index + 1] === "(") {
          substitution.depth += 1;
          index += 1;
        }
        continue;
      }
      if (character !== ")") continue;
      substitution.depth -= 1;
      if (substitution.depth === 0) {
        substitutions.push(command.slice(substitution.start, index));
        substitution = undefined;
      }
      continue;
    }

    if (quote) {
      if (quote === '"' && character === "$" && command[index + 1] === "(") {
        substitution = { depth: 1, start: index + 2 };
        index += 1;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      substitution = { depth: 1, start: index + 2 };
      index += 1;
    }
  }
  return substitutions;
}

function gcloudCommandKind(tokens, index) {
  let commandIndex = index + 1;
  while (commandIndex < tokens.length) {
    const token = tokens[commandIndex];
    if (token === "alpha" || token === "beta") {
      commandIndex += 1;
      continue;
    }
    if (!token.startsWith("-")) break;
    const [flag] = token.split("=", 1);
    commandIndex += 1;
    if (
      !token.includes("=") &&
      GCLOUD_GLOBAL_FLAGS_WITH_VALUE.has(flag) &&
      commandIndex < tokens.length
    ) {
      commandIndex += 1;
    }
  }

  if (
    tokens[commandIndex] === "builds" &&
    tokens[commandIndex + 1] === "submit"
  ) {
    return "builds-submit";
  }
  if (tokens[commandIndex] === "app" && tokens[commandIndex + 1] === "deploy") {
    return "app-deploy";
  }
  return undefined;
}

function invocationArgs(tokens, gcloudIndex) {
  const args = [];
  for (let index = gcloudIndex + 1; index < tokens.length; index += 1) {
    if (SHELL_COMMAND_BOUNDARIES.has(tokens[index])) break;
    args.push(tokens[index]);
  }
  return args;
}

function wrappedGcloudIndex(tokens, wrapperIndex) {
  let commandIndex = wrapperIndex;
  while (SHELL_COMMAND_WRAPPERS.has(tokens[commandIndex])) {
    const nextIndex = wrappedCommandIndex(tokens, commandIndex);
    if (nextIndex === null) return undefined;
    if (nextIndex === undefined) {
      for (let index = commandIndex + 1; index < tokens.length; index += 1) {
        if (SHELL_COMMAND_BOUNDARIES.has(tokens[index])) return undefined;
        if (tokens[index] === "gcloud" && gcloudCommandKind(tokens, index)) {
          return index;
        }
      }
      return undefined;
    }
    commandIndex = nextIndex;
  }
  return tokens[commandIndex] === "gcloud" &&
    gcloudCommandKind(tokens, commandIndex)
    ? commandIndex
    : undefined;
}

function commandStartIndex(tokens, index) {
  let commandIndex = index;
  while (
    SHELL_COMMAND_PREFIXES.has(tokens[commandIndex]) ||
    isAssignment(tokens[commandIndex])
  ) {
    commandIndex += 1;
  }
  while (SHELL_COMMAND_WRAPPERS.has(tokens[commandIndex])) {
    const nextIndex = wrappedCommandIndex(tokens, commandIndex);
    if (nextIndex === null || nextIndex === undefined) return undefined;
    commandIndex = nextIndex;
  }
  return commandIndex;
}

function opaqueExecutionError(filePath, surface, boundary) {
  return `${filePath}: ${surface}: opaque shell ${boundary} prevents deploy-staging discovery`;
}

function writtenShellPath(command) {
  const match = command.match(/(?:>|>>)\s*(\/[^\s;|&]+)/u);
  return match?.[1];
}

function opaqueShellErrors(filePath, surface, contents, errors) {
  const commands = shellCommands(contents);
  if (!commands.some((command) => DEPLOY_COMMAND_PATTERN.test(command))) return;
  const writtenPaths = new Set();
  const opaqueErrors = new Set();
  const recordOpaqueError = (boundary) =>
    opaqueErrors.add(opaqueExecutionError(filePath, surface, boundary));
  for (const command of commands) {
    const outputPath = writtenShellPath(command);
    if (outputPath && DEPLOY_COMMAND_PATTERN.test(command)) {
      writtenPaths.add(outputPath);
    }
  }

  for (const command of commands) {
    const tokens = shellTokens(command);
    let commandStart = true;
    for (let index = 0; index < tokens.length; index += 1) {
      if (SHELL_COMMAND_BOUNDARIES.has(tokens[index])) {
        commandStart = true;
        continue;
      }
      if (!commandStart) continue;
      const startIndex = commandStartIndex(tokens, index);
      if (startIndex === undefined) {
        commandStart = false;
        continue;
      }
      const executable = tokens[startIndex];
      if (executable === "eval") {
        recordOpaqueError("eval");
      } else if (
        SHELL_EXECUTABLES.has(executable) &&
        tokens[startIndex + 1]?.includes("c") &&
        tokens[startIndex + 1]?.startsWith("-")
      ) {
        recordOpaqueError(`${executable} -c`);
      } else if (
        executable === "xargs" &&
        tokens
          .slice(startIndex + 1)
          .some(
            (token, tokenIndex, rest) =>
              SHELL_EXECUTABLES.has(token) &&
              rest[tokenIndex + 1]?.startsWith("-") &&
              rest[tokenIndex + 1].includes("c"),
          )
      ) {
        recordOpaqueError("xargs shell evaluation");
      } else if (
        SHELL_EXECUTABLES.has(executable) &&
        writtenPaths.has(tokens[startIndex + 1])
      ) {
        recordOpaqueError(`generated ${tokens[startIndex + 1]}`);
      }
      commandStart = false;
    }
  }
  errors.push(...opaqueErrors);
}

function commandRecords(filePath, surface, contents) {
  const records = [];
  const commands = shellCommands(contents);
  for (
    let commandIndex = 0;
    commandIndex < commands.length;
    commandIndex += 1
  ) {
    const command = commands[commandIndex];
    commands.push(...commandSubstitutions(command));
    const tokens = shellTokens(command);
    let commandStart = true;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (SHELL_COMMAND_BOUNDARIES.has(token)) {
        commandStart = true;
        continue;
      }
      if (commandStart && SHELL_COMMAND_WRAPPERS.has(token)) {
        const gcloudIndex = wrappedGcloudIndex(tokens, index);
        if (gcloudIndex !== undefined) {
          records.push({
            filePath,
            surface,
            kind: gcloudCommandKind(tokens, gcloudIndex),
            invocationArgs: invocationArgs(tokens, gcloudIndex),
          });
        }
        commandStart = false;
        continue;
      }
      if (commandStart && SHELL_COMMAND_PREFIXES.has(token)) continue;
      if (commandStart && isAssignment(token)) continue;
      if (commandStart && token === "gcloud") {
        const kind = gcloudCommandKind(tokens, index);
        if (!kind) continue;
        records.push({
          filePath,
          surface,
          kind,
          invocationArgs: invocationArgs(tokens, index),
        });
      }
      commandStart = false;
    }
  }
  return records;
}

function visitYaml(value, path, callback) {
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitYaml(entry, `${path}[${index}]`, callback),
    );
    return;
  }
  if (!isMapping(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitYaml(entry, path ? `${path}.${key}` : key, callback);
  }
}

export function parseDeployStagingStructuredFile(filePath, contents, errors) {
  try {
    return filePath.endsWith(".json")
      ? JSON.parse(contents)
      : loadYaml(contents);
  } catch (error) {
    errors.push(
      `${filePath}: cannot parse executable source for deploy-staging discovery: ${error.message}`,
    );
    return undefined;
  }
}

export function discoverDeployStagingCallsites(files, errors = []) {
  const records = [];
  for (const [filePath, contents] of Object.entries(files)) {
    if (filePath.endsWith("package.json")) {
      const packageJson = parseDeployStagingStructuredFile(
        filePath,
        contents,
        errors,
      );
      if (!isMapping(packageJson?.scripts)) continue;
      for (const [name, command] of Object.entries(packageJson.scripts)) {
        if (typeof command === "string") {
          opaqueShellErrors(filePath, `scripts.${name}`, command, errors);
          records.push(...commandRecords(filePath, `scripts.${name}`, command));
        }
      }
      continue;
    }

    if (
      filePath.endsWith(".yml") ||
      filePath.endsWith(".yaml") ||
      filePath.endsWith(".json")
    ) {
      if (filePath.endsWith(".json") && !contents.includes("gcloud")) continue;
      const document = parseDeployStagingStructuredFile(
        filePath,
        contents,
        errors,
      );
      visitYaml(document, "", (value, path) => {
        if (typeof value === "string") {
          opaqueShellErrors(filePath, path, value, errors);
          records.push(...commandRecords(filePath, path, value));
        }
        if (!isMapping(value)) return;
        if (
          !/^gcr\.io\/cloud-builders\/gcloud(?::|@|$)/u.test(value.name) ||
          !Array.isArray(value.args)
        ) {
          return;
        }
        const args = value.args.map(String);
        const kind = gcloudCommandKind(["gcloud", ...args], 0);
        if (kind)
          records.push({ filePath, surface: `${path}.args`, kind, args });
      });
      continue;
    }

    if (isShellScript(filePath, contents)) {
      opaqueShellErrors(filePath, "shell", contents, errors);
      records.push(...commandRecords(filePath, "shell", contents));
    }
  }
  return records;
}
