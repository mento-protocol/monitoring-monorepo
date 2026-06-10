import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock getSecret so no Secret Manager calls happen
const mockGetSecret = vi.fn();
vi.mock("../../utils/get-secret.js", () => ({
  default: mockGetSecret,
}));

// Mock config to avoid env-schema validation during tests
vi.mock("../../config.js", () => ({
  default: {
    QUICKNODE_API_KEY_SECRET_ID: "quicknode-api-key",
  },
}));

interface FakeWebhook {
  id: string;
  name: string;
  status: string;
}

function mockWebhooksResponse(webhooks: FakeWebhook[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: webhooks }),
    }),
  );
}

const ACTIVE_WEBHOOKS: FakeWebhook[] = [
  { id: "1", name: "SortedOracles", status: "active" },
  { id: "2", name: "MentoGovernor", status: "active" },
];

describe("checkWebhookStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockGetSecret.mockResolvedValue("test-api-key");
  });

  it("reports healthy when both expected webhooks are active", async () => {
    mockWebhooksResponse(ACTIVE_WEBHOOKS);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(true);
    expect(result.unhealthyWebhooks).toEqual([]);
  });

  it("reports unhealthy when the account has no webhooks at all", async () => {
    mockWebhooksResponse([]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(false);
    expect(result.unhealthyWebhooks).toEqual([
      "SortedOracles (missing)",
      "MentoGovernor (missing)",
    ]);
  });

  it("reports unhealthy when one expected webhook is missing", async () => {
    mockWebhooksResponse([ACTIVE_WEBHOOKS[0]]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(false);
    expect(result.unhealthyWebhooks).toEqual(["MentoGovernor (missing)"]);
  });

  it("reports unhealthy when an expected webhook is present but not active", async () => {
    mockWebhooksResponse([
      ACTIVE_WEBHOOKS[0],
      { id: "2", name: "MentoGovernor", status: "paused" },
    ]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(false);
    expect(result.unhealthyWebhooks).toEqual(["MentoGovernor (paused)"]);
  });

  it("reads the API key secret id from config", async () => {
    mockWebhooksResponse(ACTIVE_WEBHOOKS);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    await checkWebhookStatus();

    expect(mockGetSecret).toHaveBeenCalledWith("quicknode-api-key");
  });
});
