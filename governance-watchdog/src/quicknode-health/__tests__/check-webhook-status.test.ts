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
  network: string;
}

function fakePage(webhooks: FakeWebhook[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ data: webhooks }),
  };
}

function mockWebhooksResponse(webhooks: FakeWebhook[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakePage(webhooks)));
}

const ACTIVE_WEBHOOKS: FakeWebhook[] = [
  { id: "1", name: "SortedOracles", status: "active", network: "celo-mainnet" },
  { id: "2", name: "MentoGovernor", status: "active", network: "celo-mainnet" },
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

  it("treats a same-named webhook on another network as missing", async () => {
    mockWebhooksResponse([
      {
        id: "1",
        name: "SortedOracles",
        status: "active",
        network: "ethereum-mainnet",
      },
      ACTIVE_WEBHOOKS[1],
    ]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(false);
    expect(result.unhealthyWebhooks).toEqual(["SortedOracles (missing)"]);
  });

  it("stays healthy when an unexpected webhook is inactive", async () => {
    mockWebhooksResponse([
      ...ACTIVE_WEBHOOKS,
      {
        id: "3",
        name: "StagingWebhook",
        status: "paused",
        network: "celo-mainnet",
      },
    ]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(true);
    expect(result.unhealthyWebhooks).toEqual([]);
  });

  it("reports unhealthy when an expected webhook is present but not active", async () => {
    mockWebhooksResponse([
      ACTIVE_WEBHOOKS[0],
      {
        id: "2",
        name: "MentoGovernor",
        status: "paused",
        network: "celo-mainnet",
      },
    ]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(false);
    expect(result.unhealthyWebhooks).toEqual(["MentoGovernor (paused)"]);
  });

  it("pages through all webhooks before deciding one is missing", async () => {
    // First page is full (100 unrelated webhooks); the expected ones are on page 2
    const filler: FakeWebhook[] = Array.from({ length: 100 }, (_, i) => ({
      id: `filler-${String(i)}`,
      name: `Other-${String(i)}`,
      status: "active",
      network: "celo-mainnet",
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakePage(filler))
      .mockResolvedValueOnce(fakePage(ACTIVE_WEBHOOKS));
    vi.stubGlobal("fetch", fetchMock);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=100&offset=0");
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "limit=100&offset=100",
    );
  });

  it("reads the API key secret id from config", async () => {
    mockWebhooksResponse(ACTIVE_WEBHOOKS);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    await checkWebhookStatus();

    expect(mockGetSecret).toHaveBeenCalledWith("quicknode-api-key");
  });
});
