import config from "../config.js";
import getSecret from "../utils/get-secret.js";
import { sendWithRetry } from "../utils/send-with-retry.js";

/**
 * Per-attempt timeout so 3 attempts (1 try + 2 retries) stay well under the
 * 60s Cloud Function timeout, mirroring the cap on the Discord send.
 */
const TELEGRAM_REQUEST_TIMEOUT_MS = 3000;

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

  await sendWithRetry(() => attemptSendTelegramMessage(botUrl, payload), {
    isRetryable: isRetryableTelegramError,
  });
}

/**
 * A failed Telegram `sendMessage` call, carrying the HTTP status so the
 * retry layer can tell a transient failure from a terminal one.
 */
class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

async function attemptSendTelegramMessage(
  botUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(botUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new TelegramApiError(
      `Failed to send telegram notification: ${errorData}`,
      response.status,
    );
  }
}

/**
 * Classifies a Telegram send failure as retryable (5xx / network) or
 * terminal (4xx, including 429). Telegram's flood-control 429 response
 * carries a `parameters.retry_after` that can exceed our whole retry budget
 * so 429 is treated as terminal rather than retried blind.
 */
function isRetryableTelegramError(error: unknown): boolean {
  if (error instanceof TelegramApiError) {
    return error.status >= 500 && error.status <= 599;
  }

  // Network-level failures (fetch rejecting, including our own timeout) are transient.
  return true;
}
