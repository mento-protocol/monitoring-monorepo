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

  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeSlackText(content.title)}*\n${toSlackMrkdwn(
            content.description,
          )}`,
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: fieldLines,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<!date^${Math.floor(
              Date.parse(content.timestamp) / 1000,
            )}^{date_short_pretty} {time_secs}|${content.timestamp}>`,
          },
        ],
      },
    ],
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
        const error = new Error(
          `Slack chat.postMessage failed: ${response.data?.error ?? "unknown"}`,
        ) as AxiosError;
        error.response = {
          ...response,
          data: response.data,
        };
        throw error;
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
      const axiosError = error as AxiosError<{ error?: string }>;
      const isLastAttempt = attempt === SLACK_RETRY_CONFIG.maxRetries;

      logger.warn("Slack postMessage attempt failed", {
        attempt: attempt + 1,
        maxRetries: SLACK_RETRY_CONFIG.maxRetries + 1,
        error:
          axiosError instanceof Error
            ? {
                name: axiosError.name,
                message: axiosError.message,
              }
            : String(axiosError),
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        slackError: axiosError.response?.data?.error,
      });

      if (!isLastAttempt && isRetryableError(error)) {
        const delay = calculateRetryDelay(attempt);
        logger.info("Retrying Slack postMessage request", {
          attempt: attempt + 2,
          delayMs: delay,
        });
        await sleep(delay, signal);
        continue;
      }

      break;
    }
  }

  const axiosError = lastError as AxiosError<{ error?: string }>;
  logger.error("Slack postMessage failed after all retries", {
    error:
      axiosError instanceof Error
        ? {
            name: axiosError.name,
            message: axiosError.message,
            stack: axiosError.stack,
          }
        : String(axiosError),
    status: axiosError.response?.status,
    statusText: axiosError.response?.statusText,
    slackError: axiosError.response?.data?.error,
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
