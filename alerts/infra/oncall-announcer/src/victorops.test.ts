import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { fetchCurrentOncall, fetchOncallUserEmail } from "./victorops";

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
    escalationPolicySlug: "primary-policy",
    teamSlug: "mento-team",
  },
  state: {
    bucket: "state-bucket",
    object: "current-oncall.json",
  },
  supportIssuesUrl: "https://linear.app/mento-labs/team/SUP/all",
};

function response(body: unknown, ok = true): Response {
  return {
    json: vi.fn(async () => body),
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
  } as unknown as Response;
}

describe("fetchCurrentOncall", () => {
  it("selects the configured team and escalation policy", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        teamsOnCall: [
          {
            team: { name: "Other", slug: "other-team" },
            oncallNow: [
              {
                escalationPolicy: { name: "Other", slug: "other-policy" },
                users: [{ onCalluser: { username: "other" } }],
              },
            ],
          },
          {
            team: { name: "Mento", slug: "mento-team" },
            oncallNow: [
              {
                escalationPolicy: {
                  name: "Primary",
                  slug: "primary-policy",
                },
                users: [
                  {
                    onCalluser: {
                      email: "chapati@example.com",
                      username: "chapati",
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    await expect(fetchCurrentOncall(config, fetchMock)).resolves.toEqual({
      email: "chapati@example.com",
      escalationPolicyName: "Primary",
      escalationPolicySlug: "primary-policy",
      teamName: "Mento",
      teamSlug: "mento-team",
      username: "chapati",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.victorops.com/api-public/v1/oncall/current",
      {
        headers: {
          "X-VO-Api-Id": "api-id",
          "X-VO-Api-Key": "api-key",
        },
      },
    );
  });

  it("fails clearly when no current user is present", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        teamsOnCall: [
          {
            team: { name: "Mento", slug: "mento-team" },
            oncallNow: [
              {
                escalationPolicy: {
                  name: "Primary",
                  slug: "primary-policy",
                },
                users: [],
              },
            ],
          },
        ],
      }),
    );

    await expect(fetchCurrentOncall(config, fetchMock)).rejects.toThrow(
      "No on-call user found",
    );
  });
});

describe("fetchOncallUserEmail", () => {
  it("finds the email for a VictorOps username", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        users: [
          { email: "other@example.com", username: "other" },
          { email: "chapati@example.com", username: "chapati" },
        ],
      }),
    );

    await expect(
      fetchOncallUserEmail("chapati", config, fetchMock),
    ).resolves.toBe("chapati@example.com");
  });
});
