import { JSONSchemaType, envSchema } from "env-schema";

interface Env {
  GCP_PROJECT_ID: string;
  DISCORD_WEBHOOK_URL_SECRET_ID: string;
  DISCORD_TEST_WEBHOOK_URL_SECRET_ID: string;
  QUICKNODE_SECURITY_TOKEN_SECRET_ID: string;
  X_AUTH_TOKEN_SECRET_ID: string;
  TELEGRAM_BOT_TOKEN_SECRET_ID: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_TEST_CHAT_ID: string;
}

const schema: JSONSchemaType<Env> = {
  type: "object",
  required: [
    "GCP_PROJECT_ID",
    "DISCORD_WEBHOOK_URL_SECRET_ID",
    "QUICKNODE_SECURITY_TOKEN_SECRET_ID",
    "X_AUTH_TOKEN_SECRET_ID",
    "TELEGRAM_BOT_TOKEN_SECRET_ID",
    "TELEGRAM_CHAT_ID",
  ],
  properties: {
    GCP_PROJECT_ID: { type: "string" },
    DISCORD_WEBHOOK_URL_SECRET_ID: { type: "string" },
    DISCORD_TEST_WEBHOOK_URL_SECRET_ID: { type: "string" },
    QUICKNODE_SECURITY_TOKEN_SECRET_ID: { type: "string" },
    X_AUTH_TOKEN_SECRET_ID: { type: "string" },
    TELEGRAM_BOT_TOKEN_SECRET_ID: { type: "string" },
    TELEGRAM_CHAT_ID: { type: "string" },
    TELEGRAM_TEST_CHAT_ID: { type: "string" },
  },
};

const config = envSchema({
  schema,
  dotenv: true, // load .env if it is there
});

export default config;
