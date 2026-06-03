import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { handleRotation, type RotationDependencies } from "./rotation";
import type { CurrentOncall, RotationState } from "./types";

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
  },
}));

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
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
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<RotationDependencies> = {},
): RotationDependencies {
  return {
    fetchCurrentOncall: vi.fn(),
    fetchOncallUserEmail: vi.fn(),
    lookupSlackUserByEmail: vi.fn(),
    now: vi.fn(() => new Date("2026-06-03T12:00:00.000Z")),
    postOncallAnnouncement: vi.fn(),
    readRotationState: vi.fn(),
    updateSupportUsergroup: vi.fn(),
    writeRotationState: vi.fn(),
    ...overrides,
  };
}

const currentOncall: CurrentOncall = {
  escalationPolicySlug: "primary",
  teamSlug: "mento",
  username: "chapati",
};

const previousState: RotationState = {
  email: "old@example.com",
  escalationPolicySlug: "primary",
  slackUserId: "UOLD",
  teamSlug: "mento",
  updatedAt: "2026-05-27T12:00:00.000Z",
  victoropsUsername: "old.user",
};

describe("handleRotation", () => {
  it("announces and stores a changed on-call engineer", async () => {
    const deps = dependencies({
      fetchCurrentOncall: vi.fn(async () => currentOncall),
      fetchOncallUserEmail: vi.fn(async () => "chapati@example.com"),
      lookupSlackUserByEmail: vi.fn(async () => ({
        id: "UCHAPATI",
        name: "chapati",
      })),
      readRotationState: vi.fn(async () => previousState),
    });

    const result = await handleRotation(baseConfig(), deps);

    expect(result).toMatchObject({
      announced: true,
      changed: true,
      slackUserId: "UCHAPATI",
    });
    expect(deps.updateSupportUsergroup).toHaveBeenCalledWith(
      "UCHAPATI",
      expect.any(Object),
    );
    expect(deps.postOncallAnnouncement).toHaveBeenCalledWith(
      "UCHAPATI",
      "chapati",
      expect.any(Object),
    );
    expect(deps.writeRotationState).toHaveBeenCalledWith(
      {
        email: "chapati@example.com",
        escalationPolicySlug: "primary",
        slackUserId: "UCHAPATI",
        teamSlug: "mento",
        updatedAt: "2026-06-03T12:00:00.000Z",
        victoropsUsername: "chapati",
      },
      expect.any(Object),
    );
  });

  it("does not announce when the Splunk On-Call username is unchanged", async () => {
    const unchangedState = {
      ...previousState,
      slackUserId: "UCHAPATI",
      victoropsUsername: "chapati",
    };
    const deps = dependencies({
      fetchCurrentOncall: vi.fn(async () => currentOncall),
      readRotationState: vi.fn(async () => unchangedState),
    });

    const result = await handleRotation(baseConfig(), deps);

    expect(result).toMatchObject({
      announced: false,
      changed: false,
      slackUserId: "UCHAPATI",
    });
    expect(deps.fetchOncallUserEmail).not.toHaveBeenCalled();
    expect(deps.lookupSlackUserByEmail).not.toHaveBeenCalled();
    expect(deps.postOncallAnnouncement).not.toHaveBeenCalled();
    expect(deps.writeRotationState).not.toHaveBeenCalled();
    expect(deps.updateSupportUsergroup).toHaveBeenCalledWith(
      "UCHAPATI",
      expect.any(Object),
    );
  });

  it("can seed first-run state without posting an announcement", async () => {
    const deps = dependencies({
      fetchCurrentOncall: vi.fn(async () => ({
        ...currentOncall,
        email: "chapati@example.com",
      })),
      lookupSlackUserByEmail: vi.fn(async () => ({ id: "UCHAPATI" })),
      readRotationState: vi.fn(async () => undefined),
    });

    const result = await handleRotation(
      baseConfig({ announceOnFirstRun: false }),
      deps,
    );

    expect(result).toMatchObject({
      announced: false,
      changed: true,
      slackUserId: "UCHAPATI",
    });
    expect(deps.fetchOncallUserEmail).not.toHaveBeenCalled();
    expect(deps.postOncallAnnouncement).not.toHaveBeenCalled();
    expect(deps.updateSupportUsergroup).toHaveBeenCalledWith(
      "UCHAPATI",
      expect.any(Object),
    );
    expect(deps.writeRotationState).toHaveBeenCalledOnce();
  });

  it("fails before Slack side effects when Splunk On-Call has no email for the user", async () => {
    const deps = dependencies({
      fetchCurrentOncall: vi.fn(async () => currentOncall),
      fetchOncallUserEmail: vi.fn(async () => undefined),
      readRotationState: vi.fn(async () => previousState),
    });

    await expect(handleRotation(baseConfig(), deps)).rejects.toThrow(
      "No email found for Splunk On-Call user chapati",
    );

    expect(deps.lookupSlackUserByEmail).not.toHaveBeenCalled();
    expect(deps.updateSupportUsergroup).not.toHaveBeenCalled();
    expect(deps.postOncallAnnouncement).not.toHaveBeenCalled();
    expect(deps.writeRotationState).not.toHaveBeenCalled();
  });
});
