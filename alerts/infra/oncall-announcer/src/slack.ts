import type { AppConfig } from "./config";
import type { SlackUser } from "./types";

class SlackApiError extends Error {
  constructor(
    message: string,
    public readonly slackError?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

interface SlackApiResponse {
  error?: string;
  ok?: boolean;
}

interface SlackLookupByEmailResponse extends SlackApiResponse {
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
  };
}

async function slackRequest<T extends SlackApiResponse>(
  config: AppConfig,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`https://slack.com/api/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T;

  if (!response.ok || data.ok !== true) {
    throw new SlackApiError(
      `Slack API ${path} failed: ${data.error ?? response.statusText}`,
      data.error,
      response.status,
    );
  }

  return data;
}

export async function lookupSlackUserByEmail(
  email: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackUser> {
  const query = new URLSearchParams({ email });
  const data = await slackRequest<SlackLookupByEmailResponse>(
    config,
    "GET",
    `users.lookupByEmail?${query.toString()}`,
    undefined,
    fetchImpl,
  );

  if (!data.user?.id) {
    throw new SlackApiError("Slack users.lookupByEmail returned no user id");
  }

  return {
    id: data.user.id,
    name: data.user.name,
    realName: data.user.real_name,
  };
}

export async function postOncallAnnouncement(
  slackUserId: string,
  username: string,
  config: AppConfig,
  clientMsgId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = [
    `New support engineer: <@${slackUserId}> is on duty.`,
    `Please monitor alert channels and work through <${sanitizeSlackUrl(
      config.supportIssuesUrl,
    )}|support issues> as capacity allows.`,
  ].join("\n");

  await slackRequest(
    config,
    "POST",
    "chat.postMessage",
    {
      channel: config.slack.channelId,
      client_msg_id: clientMsgId,
      text,
      unfurl_links: false,
      unfurl_media: false,
      metadata: {
        event_type: "support_engineer_rotation",
        event_payload: {
          slack_user_id: slackUserId,
          victorops_username: username,
        },
      },
    },
    fetchImpl,
  );
}

export async function updateSupportUsergroup(
  slackUserId: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await slackRequest(
    config,
    "POST",
    "usergroups.users.update",
    {
      usergroup: config.slack.supportUsergroupId,
      users: [slackUserId],
    },
    fetchImpl,
  );
}

function sanitizeSlackUrl(value: string): string {
  return value.replace(/</g, "%3C").replace(/>/g, "%3E");
}
