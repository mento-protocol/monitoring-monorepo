import config from "../config.js";
import getSecret from "../utils/get-secret.js";

/**
 * Sends a pre-formatted HTML message to Telegram
 * @param formattedMessage HTML-formatted message string ready for Telegram
 * @returns Promise that resolves when the notification is sent
 */
export default async function sendTelegramNotification(
  formattedMessage: string,
) {
  const botToken = await getSecret(config.TELEGRAM_BOT_TOKEN_SECRET_ID);
  const botUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  // Inline notification channel selection logic
  const isDevelopment = process.env.NODE_ENV === "development";

  if (isDevelopment) {
    if (!config.TELEGRAM_TEST_CHAT_ID) {
      throw new Error("TELEGRAM_TEST_CHAT_ID env var is not set");
    }
  }

  const telegramChatId = isDevelopment
    ? config.TELEGRAM_TEST_CHAT_ID
    : config.TELEGRAM_CHAT_ID;

  const payload = {
    chat_id: telegramChatId,
    text: formattedMessage,
    parse_mode: "HTML",
  };

  const response = await fetch(botUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Failed to send telegram notification: ${errorData}`);
  }
}
