import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function repoRoot() {
  return process.cwd().endsWith("governance-watchdog")
    ? join(process.cwd(), "..")
    : process.cwd();
}

interface AlertsInfraMultisigContract {
  chain: string;
  network: string;
  safeAddressPrefix: string;
  webhookNamePrefix: string;
}

function alertsInfraMultisigContract(): AlertsInfraMultisigContract[] {
  const variables = readFileSync(
    join(repoRoot(), "alerts", "infra", "variables.tf"),
    "utf8",
  );
  const defaultBlockPattern = new RegExp(
    [
      'variable "multisigs"[\\s\\S]*?default = \\{',
      "(?<body>[\\s\\S]*?)",
      "\\n[ ]{2}\\}\\n\\n[ ]{2}validation",
    ].join(""),
  );
  const defaultBlock = defaultBlockPattern.exec(variables)?.groups?.body;
  if (!defaultBlock) {
    throw new Error(
      "Unable to locate alerts/infra var.multisigs default block",
    );
  }

  const networkByChain = new Map<string, string>();
  const chainPattern =
    /chain\s+=\s+"([^"]+)"\s+quicknode_network_name\s+=\s+"([^"]+)"/g;
  for (
    let match = chainPattern.exec(defaultBlock);
    match;
    match = chainPattern.exec(defaultBlock)
  ) {
    const [, chain, network] = match;
    const existingNetwork = networkByChain.get(chain);
    if (existingNetwork && existingNetwork !== network) {
      throw new Error(
        `alerts/infra multisigs configure conflicting networks for ${chain}`,
      );
    }
    networkByChain.set(chain, network);
  }

  const handlerConstants = readFileSync(
    join(
      repoRoot(),
      "alerts",
      "infra",
      "onchain-event-handler",
      "src",
      "constants.ts",
    ),
    "utf8",
  );
  const safePrefixByChain = new Map<string, string>();
  const safePrefixPattern =
    /^ {2}([a-z]+): \{[\s\S]*?^ {4}safeAddressPrefix: "([^"]+)",/gm;
  for (
    let match = safePrefixPattern.exec(handlerConstants);
    match;
    match = safePrefixPattern.exec(handlerConstants)
  ) {
    safePrefixByChain.set(match[1], match[2]);
  }

  return [...networkByChain.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([chain, network]) => {
      const safeAddressPrefix = safePrefixByChain.get(chain);
      if (!safeAddressPrefix) {
        throw new Error(
          `alerts/infra handler has no Safe address prefix for ${chain}`,
        );
      }
      return {
        chain,
        network,
        safeAddressPrefix,
        webhookNamePrefix: `safe-multisig-monitor-${chain}-`,
      };
    });
}

const ACTIVE_WEBHOOK = {
  sortedOracles: {
    id: "1",
    name: "SortedOracles",
    status: "active",
    network: "celo-mainnet",
  },
  mentoGovernor: {
    id: "2",
    name: "MentoGovernor",
    status: "active",
    network: "celo-mainnet",
  },
  celoSafe: {
    id: "3",
    name: "safe-multisig-monitor-celo-abc12345",
    status: "active",
    network: "celo-mainnet",
  },
  ethereumSafe: {
    id: "4",
    name: "safe-multisig-monitor-ethereum-abc12345",
    status: "active",
    network: "ethereum-mainnet",
  },
  polygonSafe: {
    id: "5",
    name: "safe-multisig-monitor-polygon-abc12345",
    status: "active",
    network: "polygon-mainnet",
  },
} satisfies Record<string, FakeWebhook>;

const ACTIVE_WEBHOOKS = Object.values(ACTIVE_WEBHOOK);

describe("checkWebhookStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockGetSecret.mockResolvedValue("test-api-key");
  });

  it("reports healthy when all expected webhooks are active", async () => {
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
      "safe-multisig-monitor-celo-* (missing or inactive)",
      "safe-multisig-monitor-ethereum-* (missing or inactive)",
      "safe-multisig-monitor-polygon-* (missing or inactive)",
    ]);
  });

  it("reports unhealthy when one expected webhook is missing", async () => {
    mockWebhooksResponse([
      ACTIVE_WEBHOOK.sortedOracles,
      ACTIVE_WEBHOOK.celoSafe,
      ACTIVE_WEBHOOK.ethereumSafe,
      ACTIVE_WEBHOOK.polygonSafe,
    ]);
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
      ACTIVE_WEBHOOK.mentoGovernor,
      ACTIVE_WEBHOOK.celoSafe,
      ACTIVE_WEBHOOK.ethereumSafe,
      ACTIVE_WEBHOOK.polygonSafe,
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
        id: "5",
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
      ACTIVE_WEBHOOK.sortedOracles,
      {
        id: "2",
        name: "MentoGovernor",
        status: "paused",
        network: "celo-mainnet",
      },
      ACTIVE_WEBHOOK.celoSafe,
      ACTIVE_WEBHOOK.ethereumSafe,
      ACTIVE_WEBHOOK.polygonSafe,
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

  it("reports unhealthy when a Safe webhook prefix has no active match", async () => {
    mockWebhooksResponse([
      ACTIVE_WEBHOOK.sortedOracles,
      ACTIVE_WEBHOOK.mentoGovernor,
      ACTIVE_WEBHOOK.celoSafe,
      {
        id: "4",
        name: "safe-multisig-monitor-ethereum-abc12345",
        status: "paused",
        network: "ethereum-mainnet",
      },
      ACTIVE_WEBHOOK.polygonSafe,
    ]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(false);
    expect(result.unhealthyWebhooks).toEqual([
      "safe-multisig-monitor-ethereum-* (missing or inactive)",
    ]);
  });

  it("stays healthy when a paused old Safe webhook lingers next to an active replacement", async () => {
    mockWebhooksResponse([
      ...ACTIVE_WEBHOOKS,
      {
        id: "5",
        name: "safe-multisig-monitor-celo-deadbeef",
        status: "paused",
        network: "celo-mainnet",
      },
    ]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(true);
    expect(result.unhealthyWebhooks).toEqual([]);
  });

  it("treats a Safe webhook on the wrong network as missing", async () => {
    mockWebhooksResponse([
      ACTIVE_WEBHOOK.sortedOracles,
      ACTIVE_WEBHOOK.mentoGovernor,
      ACTIVE_WEBHOOK.celoSafe,
      {
        id: "4",
        name: "safe-multisig-monitor-ethereum-abc12345",
        status: "active",
        network: "celo-mainnet",
      },
      ACTIVE_WEBHOOK.polygonSafe,
    ]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    const result = await checkWebhookStatus();

    expect(result.healthy).toBe(false);
    expect(result.unhealthyWebhooks).toEqual([
      "safe-multisig-monitor-ethereum-* (missing or inactive)",
    ]);
  });

  it("covers every alerts/infra multisig chain with its network and Safe prefix", async () => {
    const contract = alertsInfraMultisigContract();
    expect(contract).toContainEqual({
      chain: "polygon",
      network: "polygon-mainnet",
      safeAddressPrefix: "matic",
      webhookNamePrefix: "safe-multisig-monitor-polygon-",
    });

    mockWebhooksResponse([]);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");
    const result = await checkWebhookStatus();
    const missingSafeWebhooks = result.unhealthyWebhooks.filter((message) =>
      message.startsWith("safe-multisig-monitor-"),
    );

    expect(missingSafeWebhooks).toEqual(
      contract.map(
        ({ webhookNamePrefix }) =>
          `${webhookNamePrefix}* (missing or inactive)`,
      ),
    );
  });

  it("reads the API key secret id from config", async () => {
    mockWebhooksResponse(ACTIVE_WEBHOOKS);
    const { checkWebhookStatus } = await import("../check-webhook-status.js");

    await checkWebhookStatus();

    expect(mockGetSecret).toHaveBeenCalledWith("quicknode-api-key");
  });
});
