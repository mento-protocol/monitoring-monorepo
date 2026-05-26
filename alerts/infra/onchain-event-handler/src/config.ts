import { JSONSchemaType, envSchema } from "env-schema";

interface Env {
  FUNCTION_TIMEOUT_SECONDS?: string;
  MULTISIG_CONFIG: string;
  QUICKNODE_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ALERTS: string;
  SLACK_CHANNEL_EVENTS: string;
}

const schema: JSONSchemaType<Env> = {
  type: "object",
  required: [
    "MULTISIG_CONFIG",
    "QUICKNODE_SIGNING_SECRET",
    "SLACK_BOT_TOKEN",
    "SLACK_CHANNEL_ALERTS",
    "SLACK_CHANNEL_EVENTS",
  ],
  properties: {
    FUNCTION_TIMEOUT_SECONDS: { type: "string", nullable: true },
    MULTISIG_CONFIG: { type: "string", minLength: 1 },
    QUICKNODE_SIGNING_SECRET: { type: "string", minLength: 1 },
    SLACK_BOT_TOKEN: { type: "string", minLength: 1 },
    SLACK_CHANNEL_ALERTS: { type: "string", minLength: 1 },
    SLACK_CHANNEL_EVENTS: { type: "string", minLength: 1 },
  },
};

const config = envSchema({
  schema,
  dotenv: true, // load .env if it is there
});

export default config;
