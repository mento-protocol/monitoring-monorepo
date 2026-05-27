/**
 * Slack message formatting and sending.
 */

import axios, { AxiosError } from "axios";
import { SLACK_WEB_API_TIMEOUT_MS } from "./constants";
import { logger } from "./logger";
import { formatNotificationContent } from "./notifier";
import type { NotificationContent, QuickNodeDecodedLog } from "./types";

interface SlackBlock {
  type: "section" | "divider" | "context";
  text?: {
    type: "mrkdwn";
    text: string;
  };
  elements?: Array<{
    type: "mrkdwn";
    text: string;
  }>;
}

interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

class SlackApiError extends Error {
  constructor(
    public readonly slackError: string,
    public readonly status: number,
    public readonly statusText?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`Slack chat.postMessage failed: ${slackError}`);
    this.name = "SlackApiError";
  }
}

export async function formatSlackMessage(
  eventName: string,
  log: QuickNodeDecodedLog,
  multisigKey: string,
  txHashMap: Map<string, string>,
  signal?: AbortSignal,
): Promise<SlackMessage> {
  const content = await formatNotificationContent(
    eventName,
    log,
    multisigKey,
    txHashMap,
    signal,
  );

  return formatSlackMessageFromContent(content);
}

function formatSlackMessageFromContent(
  content: NotificationContent,
): SlackMessage {
  const fieldLines = content.fields
    .map((field) => `*${field.name}*\n${toSlackMrkdwn(field.value)}`)
    .join("\n\n");
  const text = `${content.title}: ${stripMarkdown(content.description)}`;
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlackText(content.title)}*\n${toSlackMrkdwn(
          content.description,
        )}`,
      },
    },
  ];

  if (fieldLines.length > 0) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: fieldLines,
        },
      },
    );
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `<!date^${Math.floor(
          Date.parse(content.timestamp) / 1000,
        )}^{date_short_pretty} {time_secs}|${content.timestamp}>`,
      },
    ],
  });

  return {
    text,
    blocks,
  };
}

function toSlackMrkdwn(value: string): string {
  const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let result = "";
  let lastIndex = 0;

  for (const match of value.matchAll(markdownLink)) {
    const [fullMatch, label, url] = match;
    const index = match.index ?? 0;
    result += escapeSlackText(value.slice(lastIndex, index));
    result += `<${sanitizeSlackUrl(url)}|${escapeSlackText(label)}>`;
    lastIndex = index + fullMatch.length;
  }

  result += escapeSlackText(value.slice(lastIndex));
  return result;
}

function sanitizeSlackUrl(value: string): string {
  return value.replace(/</g, "%3C").replace(/>/g, "%3E");
}

function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1");
}

const SLACK_RETRY_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 1000,
  retryableStatusCodes: [429, 500, 502, 503, 504] as number[],
  retryableSlackErrors: [
    "ratelimited",
    "fatal_error",
    "internal_error",
  ] as string[],
} as const;

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "Operation aborted")
  );
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (isAbortError(error)) {
    return false;
  }

  if (error instanceof SlackApiError) {
    return (
      SLACK_RETRY_CONFIG.retryableStatusCodes.includes(error.status) ||
      SLACK_RETRY_CONFIG.retryableSlackErrors.includes(error.slackError)
    );
  }

  const axiosError = error as AxiosError<{ error?: string }>;
  const status = axiosError.response?.status;
  const slackError = axiosError.response?.data?.error;

  if (!status) {
    if (axiosError.code === "ERR_CANCELED") {
      return false;
    }
    if (axiosError.code === "ECONNABORTED") {
      return false;
    }
    return true;
  }

  return (
    SLACK_RETRY_CONFIG.retryableStatusCodes.includes(status) ||
    (typeof slackError === "string" &&
      SLACK_RETRY_CONFIG.retryableSlackErrors.includes(slackError))
  );
}

function calculateRetryDelay(attempt: number): number {
  return SLACK_RETRY_CONFIG.retryDelayMs * Math.pow(2, attempt);
}

function getHeader(
  headers: Record<string, unknown> | undefined,
  name: string,
): unknown {
  if (!headers) {
    return undefined;
  }

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }

  return undefined;
}

function parseRetryAfterMs(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }

  if (typeof raw === "string") {
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt)) {
      const delayMs = retryAt - Date.now();
      return delayMs > 0 ? delayMs : undefined;
    }
  }

  return undefined;
}

function getRetryAfterDelayMs(error: unknown): number | undefined {
  if (error instanceof SlackApiError) {
    return error.retryAfterMs;
  }

  const axiosError = error as AxiosError;
  return parseRetryAfterMs(
    getHeader(
      axiosError.response?.headers as Record<string, unknown> | undefined,
      "retry-after",
    ),
  );
}

function getSlackError(error: unknown): string | undefined {
  if (error instanceof SlackApiError) {
    return error.slackError;
  }

  const axiosError = error as AxiosError<{ error?: string }>;
  return axiosError.response?.data?.error;
}

function getStatus(error: unknown): number | undefined {
  if (error instanceof SlackApiError) {
    return error.status;
  }

  const axiosError = error as AxiosError;
  return axiosError.response?.status;
}

function getStatusText(error: unknown): string | undefined {
  if (error instanceof SlackApiError) {
    return error.statusText;
  }

  const axiosError = error as AxiosError;
  return axiosError.response?.statusText;
}

export async function sendToSlack(
  botToken: string,
  channelId: string,
  message: SlackMessage,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= SLACK_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const response = await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: channelId,
          text: message.text,
          blocks: message.blocks,
          unfurl_links: false,
          unfurl_media: false,
        },
        {
          headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          timeout: SLACK_WEB_API_TIMEOUT_MS,
          signal,
        },
      );

      if (response.data?.ok !== true) {
        throw new SlackApiError(
          response.data?.error ?? "unknown",
          response.status,
          response.statusText,
          parseRetryAfterMs(
            getHeader(
              response.headers as Record<string, unknown> | undefined,
              "retry-after",
            ),
          ),
        );
      }

      if (attempt > 0) {
        logger.info("Slack message sent after retry", {
          channelId,
          text: message.text,
          attempt: attempt + 1,
        });
      } else {
        logger.info("Slack message sent", {
          channelId,
          text: message.text,
        });
      }

      return;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === SLACK_RETRY_CONFIG.maxRetries;

      logger.warn("Slack postMessage attempt failed", {
        attempt: attempt + 1,
        maxRetries: SLACK_RETRY_CONFIG.maxRetries + 1,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : String(error),
        status: getStatus(error),
        statusText: getStatusText(error),
        slackError: getSlackError(error),
      });

      if (!isLastAttempt && isRetryableError(error)) {
        const retryAfterDelayMs = getRetryAfterDelayMs(error);
        const delay = retryAfterDelayMs ?? calculateRetryDelay(attempt);
        logger.info("Retrying Slack postMessage request", {
          attempt: attempt + 2,
          delayMs: delay,
          retryAfterDelayMs,
        });
        await sleep(delay, signal);
        continue;
      }

      break;
    }
  }

  logger.error("Slack postMessage failed after all retries", {
    error:
      lastError instanceof Error
        ? {
            name: lastError.name,
            message: lastError.message,
            stack: lastError.stack,
          }
        : String(lastError),
    status: getStatus(lastError),
    statusText: getStatusText(lastError),
    slackError: getSlackError(lastError),
  });

  throw lastError;
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (signal.aborted) {
    return Promise.reject(new Error("Operation aborted"));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
