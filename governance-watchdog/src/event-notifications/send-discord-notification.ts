import { EmbedBuilder } from "@discordjs/builders";
import config from "../config.js";
import getSecret from "../utils/get-secret.js";
import { sendWithRetry } from "../utils/send-with-retry.js";

/**
 * Per-attempt timeout for the Discord webhook POST. With sendWithRetry's
 * default 3 attempts (1 try + 2 retries), the request time plus backoff stays
 * well under the 60s Cloud Function timeout.
 */
const DISCORD_REQUEST_TIMEOUT_MS = 3000;

class DiscordWebhookHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, statusText: string, responseBody: string) {
    super(`Discord webhook returned ${String(status)} ${statusText}`);
    this.name = "DiscordWebhookHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Generic Discord notification function that can be reused by different event handlers
 * @param content The content message that appears above the embed
 * @param embed The pre-configured Discord embed message
 * @returns Promise that resolves when the notification is sent
 */
export default async function sendDiscordNotification(
  content: string,
  embed: EmbedBuilder,
) {
  // Inline notification channel selection logic
  const isDevelopment = process.env.NODE_ENV === "development";

  if (isDevelopment) {
    if (!config.DISCORD_TEST_WEBHOOK_URL_SECRET_ID) {
      throw new Error("DISCORD_TEST_WEBHOOK_URL_SECRET_ID env var is not set");
    }
  }

  const discordWebhookUrlSecretId = isDevelopment
    ? config.DISCORD_TEST_WEBHOOK_URL_SECRET_ID
    : config.DISCORD_WEBHOOK_URL_SECRET_ID;

  const webhookUrl = await getSecret(discordWebhookUrlSecretId);

  await sendWithRetry(
    () =>
      postDiscordWebhook(webhookUrl, {
        content,
        embeds: [embed.toJSON()],
      }),
    { isRetryable: isRetryableDiscordError },
  );
}

async function postDiscordWebhook(
  webhookUrl: string,
  payload: unknown,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });

  if (response.ok) {
    return;
  }

  const responseBody = await response.text().catch(() => "");
  throw new DiscordWebhookHttpError(
    response.status,
    response.statusText,
    responseBody,
  );
}

/**
 * Classifies a Discord send failure as retryable (5xx / network) or terminal
 * (4xx auth/payload/rate-limit). Discord's 429 response includes a retry_after
 * hint, but this function runs inside a 60s Cloud Function request path; avoid
 * blind channel-level retry sleeps and let the next webhook event attempt later.
 */
function isRetryableDiscordError(error: unknown): boolean {
  if (error instanceof DiscordWebhookHttpError) {
    return error.status >= 500 && error.status <= 599;
  }

  // Anything else (network failures, timeouts, DNS errors) is transient.
  return true;
}
