import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import {
  lookupSlackUserByEmail,
  postOncallAnnouncement,
  updateSupportUsergroup,
} from "./slack";

const config: AppConfig = {
  announceOnFirstRun: true,
  slack: {
    botToken: "xoxb-test",
    channelId: "CENG",
    supportUsergroupId: "S_SUPPORT",
  },
  splunkOnCall: {
    apiBaseUrl: "https://api.victorops.com",
    apiId: "api-id",
    apiKey: "api-key",
  },
  state: {
    bucket: "state-bucket",
    object: "current-oncall.json",
  },
  supportIssuesUrl: "https://linear.app/mento-labs/team/SUP/all",
};

function slackResponse(body: unknown, ok = true): Response {
  return {
    json: vi.fn(async () => body),
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
  } as unknown as Response;
}

describe("Slack API helpers", () => {
  it("looks up a Slack user by email", async () => {
    const fetchMock = vi.fn(async () =>
      slackResponse({
        ok: true,
        user: {
          id: "UCHAPATI",
          name: "chapati",
          real_name: "Philip",
        },
      }),
    );

    await expect(
      lookupSlackUserByEmail("chapati@example.com", config, fetchMock),
    ).resolves.toEqual({
      id: "UCHAPATI",
      name: "chapati",
      realName: "Philip",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/users.lookupByEmail?email=chapati%40example.com",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-test",
        }),
        method: "GET",
      }),
    );
  });

  it("posts the on-call announcement to the configured channel", async () => {
    const fetchMock = vi.fn(async () => slackResponse({ ok: true }));

    await postOncallAnnouncement(
      "UCHAPATI",
      "chapati",
      config,
      "e6f87c4e-fbfd-5887-81e7-7ad2fd6c2a43",
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        body: JSON.stringify({
          channel: "CENG",
          client_msg_id: "e6f87c4e-fbfd-5887-81e7-7ad2fd6c2a43",
          text: [
            "New support engineer: <@UCHAPATI> is on duty.",
            "Please monitor alert channels and work through <https://linear.app/mento-labs/team/SUP/all|support issues> as capacity allows.",
          ].join("\n"),
          unfurl_links: false,
          unfurl_media: false,
          metadata: {
            event_type: "support_engineer_rotation",
            event_payload: {
              slack_user_id: "UCHAPATI",
              victorops_username: "chapati",
            },
          },
        }),
        method: "POST",
      }),
    );
  });

  it("replaces the support-engineer usergroup with exactly one user", async () => {
    const fetchMock = vi.fn(async () => slackResponse({ ok: true }));

    await updateSupportUsergroup("UCHAPATI", config, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/usergroups.users.update",
      expect.objectContaining({
        body: JSON.stringify({
          usergroup: "S_SUPPORT",
          users: ["UCHAPATI"],
        }),
        method: "POST",
      }),
    );
  });

  it("throws when Slack returns ok=false", async () => {
    const fetchMock = vi.fn(async () =>
      slackResponse({ ok: false, error: "missing_scope" }),
    );

    await expect(
      updateSupportUsergroup("UCHAPATI", config, fetchMock),
    ).rejects.toThrow("missing_scope");
  });
});
