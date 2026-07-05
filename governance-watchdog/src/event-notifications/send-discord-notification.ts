import {
  DiscordAPIError,
  EmbedBuilder,
  HTTPError,
  RateLimitError,
  WebhookClient,
} from "discord.js";
import config from "../config.js";
import getSecret from "../utils/get-secret.js";
import { sendWithRetry } from "../utils/send-with-retry.js";

/**
 * Per-attempt timeout for the underlying discord.js REST call. discord.js's
 * `@discordjs/rest` retries network/5xx failures internally (3 times by
 * default, 15s timeout each) *before* ever throwing — left alone, our own
 * retry loop below would multiply on top of that hidden retry budget. We
 * disable discord.js's internal retries (`rest.retries: 0`) so this module
 * owns the whole retry budget, and cap each attempt's timeout so 3 attempts
 * (1 try + 2 retries) stay well under the 60s Cloud Function timeout.
 */
const DISCORD_REQUEST_TIMEOUT_MS = 3000;

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

  const webhookClient = new WebhookClient(
    { url: await getSecret(discordWebhookUrlSecretId) },
    { rest: { retries: 0, timeout: DISCORD_REQUEST_TIMEOUT_MS } },
  );

  await sendWithRetry(
    () =>
      webhookClient.send({
        content: content,
        embeds: [embed],
      }),
    { isRetryable: isRetryableDiscordError },
  );
}

/**
 * Classifies a Discord send failure as retryable (5xx / network) or terminal
 * (4xx auth/payload). `RateLimitError` is excluded on purpose: discord.js's
 * `WebhookClient` already queues and waits out 429s internally, and only
 * throws `RateLimitError` once it has given up on that internal handling —
 * retrying again here would double-handle the same rate limit.
 */
function isRetryableDiscordError(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return false;
  }

  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    return error.status >= 500 && error.status <= 599;
  }

  // Anything else (network failures, timeouts, DNS errors) is transient.
  return true;
}
