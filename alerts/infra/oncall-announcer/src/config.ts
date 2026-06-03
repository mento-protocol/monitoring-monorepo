import { JSONSchemaType, envSchema } from "env-schema";

interface Env {
  ANNOUNCE_ON_FIRST_RUN?: string;
  ONCALL_STATE_BUCKET: string;
  ONCALL_STATE_OBJECT?: string;
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string;
  SLACK_SUPPORT_USERGROUP_ID: string;
  SPLUNK_ON_CALL_API_BASE_URL?: string;
  SPLUNK_ON_CALL_API_ID: string;
  SPLUNK_ON_CALL_API_KEY: string;
  SPLUNK_ON_CALL_ESCALATION_POLICY_SLUG?: string;
  SPLUNK_ON_CALL_TEAM_SLUG?: string;
  SUPPORT_ISSUES_URL: string;
}

const schema: JSONSchemaType<Env> = {
  type: "object",
  required: [
    "ONCALL_STATE_BUCKET",
    "SLACK_BOT_TOKEN",
    "SLACK_CHANNEL_ID",
    "SLACK_SUPPORT_USERGROUP_ID",
    "SPLUNK_ON_CALL_API_ID",
    "SPLUNK_ON_CALL_API_KEY",
    "SUPPORT_ISSUES_URL",
  ],
  properties: {
    ANNOUNCE_ON_FIRST_RUN: { type: "string", nullable: true },
    ONCALL_STATE_BUCKET: { type: "string", minLength: 1 },
    ONCALL_STATE_OBJECT: { type: "string", nullable: true },
    SLACK_BOT_TOKEN: { type: "string", minLength: 1 },
    SLACK_CHANNEL_ID: { type: "string", minLength: 1 },
    SLACK_SUPPORT_USERGROUP_ID: { type: "string", minLength: 1 },
    SPLUNK_ON_CALL_API_BASE_URL: { type: "string", nullable: true },
    SPLUNK_ON_CALL_API_ID: { type: "string", minLength: 1 },
    SPLUNK_ON_CALL_API_KEY: { type: "string", minLength: 1 },
    SPLUNK_ON_CALL_ESCALATION_POLICY_SLUG: {
      type: "string",
      nullable: true,
    },
    SPLUNK_ON_CALL_TEAM_SLUG: { type: "string", nullable: true },
    SUPPORT_ISSUES_URL: { type: "string", minLength: 1 },
  },
};

const env = envSchema({
  schema,
  dotenv: true,
});

function optionalValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = optionalValue(value)?.toLowerCase();
  if (normalized === undefined) {
    return fallback;
  }
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

export interface AppConfig {
  announceOnFirstRun: boolean;
  slack: {
    botToken: string;
    channelId: string;
    supportUsergroupId: string;
  };
  splunkOnCall: {
    apiBaseUrl: string;
    apiId: string;
    apiKey: string;
    escalationPolicySlug?: string;
    teamSlug?: string;
  };
  state: {
    bucket: string;
    object: string;
  };
  supportIssuesUrl: string;
}

const config: AppConfig = {
  announceOnFirstRun: parseBoolean(env.ANNOUNCE_ON_FIRST_RUN, true),
  slack: {
    botToken: env.SLACK_BOT_TOKEN,
    channelId: env.SLACK_CHANNEL_ID,
    supportUsergroupId: env.SLACK_SUPPORT_USERGROUP_ID,
  },
  splunkOnCall: {
    apiBaseUrl:
      optionalValue(env.SPLUNK_ON_CALL_API_BASE_URL) ??
      "https://api.victorops.com",
    apiId: env.SPLUNK_ON_CALL_API_ID,
    apiKey: env.SPLUNK_ON_CALL_API_KEY,
    escalationPolicySlug: optionalValue(
      env.SPLUNK_ON_CALL_ESCALATION_POLICY_SLUG,
    ),
    teamSlug: optionalValue(env.SPLUNK_ON_CALL_TEAM_SLUG),
  },
  state: {
    bucket: env.ONCALL_STATE_BUCKET,
    object: optionalValue(env.ONCALL_STATE_OBJECT) ?? "current-oncall.json",
  },
  supportIssuesUrl: env.SUPPORT_ISSUES_URL,
};

export default config;
