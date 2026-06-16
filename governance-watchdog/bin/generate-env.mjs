#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tfvarsPath = join(packageRoot, "infra", "terraform.tfvars");
const envPath = join(packageRoot, ".env");

const defaultValues = {
  discord_webhook_url_secret_id: "discord-webhook-url",
  discord_test_webhook_url_secret_id: "discord-test-webhook-url",
  telegram_bot_token_secret_id: "telegram-bot-token",
  quicknode_api_key_secret_id: "quicknode-api-key",
  quicknode_security_token_secret_id: "quicknode-security-token",
  x_auth_token_secret_id: "x-auth-token",
};

function stripInlineComment(value) {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const prev = value[i - 1];
    if (char === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    if (char === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    if (char === "#" && !inDouble && !inSingle) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function parseValue(raw) {
  const value = stripInlineComment(raw);
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseTfvars(path) {
  if (!existsSync(path)) return {};

  const result = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    result[match[1]] = parseValue(match[2]);
  }
  return result;
}

function readTerraformOutput(name) {
  try {
    return execFileSync("terraform", ["-chdir=infra", "output", "-raw", name], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    const detail = stderr ? `\n${stderr}` : "";
    throw new Error(
      `Unable to read terraform output "${name}". Run terraform init/apply for governance-watchdog first.${detail}`,
    );
  }
}

const tfvars = parseTfvars(tfvarsPath);

function valueFor(name, options = {}) {
  const value =
    process.env[`TF_VAR_${name}`] ?? tfvars[name] ?? defaultValues[name];
  if (options.required && (value === undefined || value === "")) {
    throw new Error(
      `Missing required value "${name}". Add it to governance-watchdog/infra/terraform.tfvars or export TF_VAR_${name}.`,
    );
  }
  return value ?? "";
}

const lines = [
  ["GCP_PROJECT_ID", readTerraformOutput("project_id")],
  ["DISCORD_WEBHOOK_URL_SECRET_ID", valueFor("discord_webhook_url_secret_id")],
  [
    "DISCORD_TEST_WEBHOOK_URL_SECRET_ID",
    valueFor("discord_test_webhook_url_secret_id"),
  ],
  ["TELEGRAM_BOT_TOKEN_SECRET_ID", valueFor("telegram_bot_token_secret_id")],
  ["TELEGRAM_CHAT_ID", valueFor("telegram_chat_id", { required: true })],
  [
    "TELEGRAM_TEST_CHAT_ID",
    valueFor("telegram_test_chat_id", { required: true }),
  ],
  ["QUICKNODE_API_KEY_SECRET_ID", valueFor("quicknode_api_key_secret_id")],
  [
    "QUICKNODE_SECURITY_TOKEN_SECRET_ID",
    valueFor("quicknode_security_token_secret_id"),
  ],
  ["X_AUTH_TOKEN_SECRET_ID", valueFor("x_auth_token_secret_id")],
];

writeFileSync(
  envPath,
  `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
);

console.log(`Wrote ${envPath}`);
