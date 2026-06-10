import { EmbedBuilder, WebhookClient } from "discord.js";
import config from "../config.js";
import getSecret from "../utils/get-secret.js";

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

  await new WebhookClient({
    url: await getSecret(discordWebhookUrlSecretId),
  }).send({
    content: content,
    embeds: [embed],
  });
}
