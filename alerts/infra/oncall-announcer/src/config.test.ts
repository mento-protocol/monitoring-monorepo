import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_ENV = {
  ONCALL_STATE_BUCKET: "state-bucket",
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_CHANNEL_ID: "C0123ABC456",
  SLACK_SUPPORT_USERGROUP_ID: "S0123ABC456",
  SPLUNK_ON_CALL_API_ID: "api-id",
  SPLUNK_ON_CALL_API_KEY: "api-key",
  SUPPORT_ISSUES_URL: "https://linear.app/mento-labs/team/SUP/all",
};

async function importConfig() {
  vi.resetModules();
  return (await import("./config")).default;
}

describe("config", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      process.env[key] = value;
    }
    delete process.env.ANNOUNCE_ON_FIRST_RUN;
    delete process.env.ONCALL_STATE_OBJECT;
    delete process.env.SPLUNK_ON_CALL_API_BASE_URL;
    delete process.env.SPLUNK_ON_CALL_ESCALATION_POLICY_SLUG;
    delete process.env.SPLUNK_ON_CALL_TEAM_SLUG;
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED_ENV)) {
      delete process.env[key];
    }
    delete process.env.ANNOUNCE_ON_FIRST_RUN;
    delete process.env.ONCALL_STATE_OBJECT;
    delete process.env.SPLUNK_ON_CALL_API_BASE_URL;
    delete process.env.SPLUNK_ON_CALL_ESCALATION_POLICY_SLUG;
    delete process.env.SPLUNK_ON_CALL_TEAM_SLUG;
  });

  it("uses defaults for optional values", async () => {
    await expect(importConfig()).resolves.toMatchObject({
      announceOnFirstRun: true,
      splunkOnCall: {
        apiBaseUrl: "https://api.victorops.com",
        apiId: "api-id",
        apiKey: "api-key",
      },
      state: {
        bucket: "state-bucket",
        object: "current-oncall.json",
      },
    });
  });

  it("normalizes optional values", async () => {
    process.env.ANNOUNCE_ON_FIRST_RUN = "false";
    process.env.ONCALL_STATE_OBJECT = "custom.json";
    process.env.SPLUNK_ON_CALL_API_BASE_URL = "https://example.com";
    process.env.SPLUNK_ON_CALL_ESCALATION_POLICY_SLUG = "primary";
    process.env.SPLUNK_ON_CALL_TEAM_SLUG = "mento";

    await expect(importConfig()).resolves.toMatchObject({
      announceOnFirstRun: false,
      splunkOnCall: {
        apiBaseUrl: "https://example.com",
        escalationPolicySlug: "primary",
        teamSlug: "mento",
      },
      state: {
        object: "custom.json",
      },
    });
  });

  it("rejects invalid boolean strings", async () => {
    process.env.ANNOUNCE_ON_FIRST_RUN = "sometimes";

    await expect(importConfig()).rejects.toThrow("Invalid boolean value");
  });
});
