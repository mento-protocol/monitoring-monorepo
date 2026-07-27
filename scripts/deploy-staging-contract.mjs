import { load as loadYaml } from "js-yaml";
import {
  expectExpression,
  expectNoResourceMultiplicity,
  expectString,
  nestedBlocks,
  requireBlock,
  terraformTopLevelBlocks,
} from "./production-infra-identity-contract/hcl.mjs";
import {
  isMapping,
  stripShellComment,
} from "./production-infra-identity-contract/workflow-inventory.mjs";

const TERRAFORM_FILE = "terraform/deploy-staging.tf";

const EXPECTED_CALLSITES = [
  {
    filePath: ".github/workflows/metrics-bridge.yml",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${GCP_PROJECT}-cloud-build-source/metrics-bridge",
  },
  {
    filePath: "scripts/deploy-bridge.sh",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${PROJECT}-cloud-build-source/metrics-bridge",
  },
  {
    filePath: "aegis/grafana-agent/deploy.sh",
    kind: "builds-submit",
    flag: "gcs-source-staging-dir",
    value: "gs://${project}-cloud-build-source/alloy",
  },
  {
    filePath: "aegis/bin/deploy.sh",
    kind: "app-deploy",
    flag: "bucket",
    value: "gs://mento-monitoring-app-engine-source",
  },
  {
    filePath: "aegis/grafana-agent/cloudbuild.yaml",
    kind: "app-deploy",
    flag: "bucket",
    value: "gs://mento-monitoring-app-engine-source",
  },
];

function requireSource(files, filePath, errors) {
  const contents = files[filePath];
  if (typeof contents !== "string") {
    errors.push(`${filePath}: file is required by the deploy-staging contract`);
    return "";
  }
  return contents;
}

function expectOneNested(block, type, errors, label) {
  const matches = nestedBlocks(block, type);
  if (matches.length !== 1) {
    errors.push(`${label}: must contain exactly one ${type} block`);
  }
  return matches[0];
}

function validateBucket(blocks, { name, suffix, location, age }, errors) {
  const label = `${TERRAFORM_FILE}: ${name}`;
  const bucket = requireBlock(
    blocks,
    TERRAFORM_FILE,
    "google_storage_bucket",
    name,
    errors,
    label,
  );
  if (!bucket) return;

  expectNoResourceMultiplicity(bucket, errors, label);
  expectExpression(
    bucket,
    "project",
    "google_project.monitoring.project_id",
    errors,
    label,
  );
  expectString(
    bucket,
    "name",
    `\${google_project.monitoring.project_id}-${suffix}`,
    errors,
    label,
  );
  if (location.startsWith('"')) {
    expectString(bucket, "location", JSON.parse(location), errors, label);
  } else {
    expectExpression(bucket, "location", location, errors, label);
  }
  expectExpression(bucket, "force_destroy", "false", errors, label);
  expectExpression(
    bucket,
    "uniform_bucket_level_access",
    "true",
    errors,
    label,
  );
  expectString(bucket, "public_access_prevention", "enforced", errors, label);
  expectExpression(
    bucket,
    "depends_on",
    "[google_project_service.storage]",
    errors,
    label,
  );

  const lifecycleRule = expectOneNested(
    bucket,
    "lifecycle_rule",
    errors,
    label,
  );
  const action = expectOneNested(lifecycleRule, "action", errors, label);
  const condition = expectOneNested(lifecycleRule, "condition", errors, label);
  expectString(action, "type", "Delete", errors, label);
  expectExpression(condition, "age", String(age), errors, label);
  expectString(condition, "with_state", "LIVE", errors, label);

  const softDelete = expectOneNested(
    bucket,
    "soft_delete_policy",
    errors,
    label,
  );
  expectExpression(
    softDelete,
    "retention_duration_seconds",
    "0",
    errors,
    label,
  );
  const lifecycle = expectOneNested(bucket, "lifecycle", errors, label);
  expectExpression(lifecycle, "prevent_destroy", "true", errors, label);
}

function validateTerraform(files, errors) {
  const contents = requireSource(files, TERRAFORM_FILE, errors);
  const blocks = terraformTopLevelBlocks(
    { [TERRAFORM_FILE]: contents },
    errors,
  );
  validateBucket(
    blocks,
    {
      name: "cloud_build_source_staging",
      suffix: "cloud-build-source",
      location: "var.gcp_region",
      age: 7,
    },
    errors,
  );
  validateBucket(
    blocks,
    {
      name: "app_engine_source_staging",
      suffix: "app-engine-source",
      location: '"US"',
      age: 30,
    },
    errors,
  );
}

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
]);

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

// This static scan follows direct commands and $(...) substitutions. Runtime
// indirection through eval, xargs, or generated shell text remains unsupported.
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
      if (SHELL_COMMAND_PREFIXES.has(token) && commandStart) continue;
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

function parseStructuredFile(filePath, contents, errors) {
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
      const packageJson = parseStructuredFile(filePath, contents, errors);
      if (!isMapping(packageJson?.scripts)) continue;
      for (const [name, command] of Object.entries(packageJson.scripts)) {
        if (typeof command === "string") {
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
      if (filePath.endsWith(".json") && !contents.includes("gcloud")) {
        continue;
      }
      const document = parseStructuredFile(filePath, contents, errors);
      visitYaml(document, "", (value, path) => {
        if (typeof value === "string") {
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
        if (kind) {
          records.push({
            filePath,
            surface: `${path}.args`,
            kind,
            args,
          });
        }
      });
      continue;
    }

    if (isShellScript(filePath, contents)) {
      records.push(...commandRecords(filePath, "shell", contents));
    }
  }
  return records;
}

function hasFlag(record, flag, value) {
  const args = record.args ?? record.invocationArgs;
  return args.some(
    (argument, index) =>
      argument === `--${flag}=${value}` ||
      (argument === `--${flag}` && args[index + 1] === value),
  );
}

function validateCallsites(files, errors) {
  const records = discoverDeployStagingCallsites(files, errors);
  const expectedKeys = EXPECTED_CALLSITES.map(
    ({ filePath, kind }) => `${filePath}:${kind}`,
  ).sort();
  const actualKeys = records
    .map(({ filePath, kind }) => `${filePath}:${kind}`)
    .sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    errors.push(
      `deploy-staging executable callsite inventory must be exactly ${expectedKeys.join(", ")}; found ${actualKeys.join(", ") || "none"}`,
    );
  }

  for (const expected of EXPECTED_CALLSITES) {
    const matches = records.filter(
      (record) =>
        record.filePath === expected.filePath && record.kind === expected.kind,
    );
    if (
      matches.length === 1 &&
      !hasFlag(matches[0], expected.flag, expected.value)
    ) {
      errors.push(
        `${expected.filePath}: ${expected.kind} must use --${expected.flag}=${expected.value}`,
      );
    }
  }

  const alloyPath = "aegis/grafana-agent/cloudbuild.yaml";
  const alloy = parseStructuredFile(
    alloyPath,
    requireSource(files, alloyPath, errors),
    errors,
  );
  if (alloy?.options?.logging !== "CLOUD_LOGGING_ONLY") {
    errors.push(`${alloyPath}: Cloud Build logging must be CLOUD_LOGGING_ONLY`);
  }
}

export function validateDeployStagingContract(files) {
  const errors = [];
  validateTerraform(files, errors);
  validateCallsites(files, errors);
  return errors;
}

export function assertDeployStagingContract(files) {
  const errors = validateDeployStagingContract(files);
  if (errors.length > 0) {
    throw new Error(
      `Deployment source-staging contract failed:\n- ${errors.join("\n- ")}`,
    );
  }
}
