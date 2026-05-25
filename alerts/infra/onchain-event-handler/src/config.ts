import { JSONSchemaType, envSchema } from "env-schema";

interface Env {
  DISCORD_WEBHOOK_ALERTS: string;
  DISCORD_WEBHOOK_EVENTS: string;
  MULTISIG_CONFIG: string;
  QUICKNODE_SIGNING_SECRET: string;
}

const schema: JSONSchemaType<Env> = {
  type: "object",
  required: [
    "DISCORD_WEBHOOK_ALERTS",
    "DISCORD_WEBHOOK_EVENTS",
    "MULTISIG_CONFIG",
    "QUICKNODE_SIGNING_SECRET",
  ],
  properties: {
    DISCORD_WEBHOOK_ALERTS: { type: "string", default: "" },
    DISCORD_WEBHOOK_EVENTS: { type: "string", default: "" },
    MULTISIG_CONFIG: { type: "string", default: "{}" },
    QUICKNODE_SIGNING_SECRET: { type: "string", default: "" },
  },
};

const config = envSchema({
  schema,
  dotenv: true, // load .env if it is there
});

export default config;
