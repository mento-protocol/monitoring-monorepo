import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import {
  readRotationState,
  resetStateTokenCacheForTests,
  writeRotationState,
} from "./state";

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
    object: "current/oncall.json",
  },
  supportIssuesUrl: "https://linear.app/mento-labs/team/SUP/all",
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    json: vi.fn(async () => body),
    ok,
    status,
    statusText: ok ? "OK" : "Error",
  } as unknown as Response;
}

describe("GCS rotation state", () => {
  it("returns undefined when the state object has not been written yet", async () => {
    resetStateTokenCacheForTests();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token" }))
      .mockResolvedValueOnce(jsonResponse({}, false, 404));

    await expect(readRotationState(config, fetchMock)).resolves.toBeUndefined();
  });

  it("writes JSON state to the configured object", async () => {
    resetStateTokenCacheForTests();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const state = {
      slackUserId: "UCHAPATI",
      updatedAt: "2026-06-03T12:00:00.000Z",
      victoropsUsername: "chapati",
    };
    await writeRotationState(state, config, fetchMock);

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://storage.googleapis.com/upload/storage/v1/b/state-bucket/o?uploadType=media&name=current%2Foncall.json",
      expect.objectContaining({
        body: JSON.stringify(state),
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json; charset=utf-8",
        }),
        method: "POST",
      }),
    );
  });
});
