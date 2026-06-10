import config from "../config.js";
import getSecret from "../utils/get-secret.js";

interface QuicknodeWebhook {
  id: string;
  name: string;
  status: string;
  network: string;
  created_at: string;
  updated_at: string;
}

interface QuicknodeWebhooksResponse {
  data: QuicknodeWebhook[];
}

interface WebhookStatus {
  name: string;
  status: string;
  isHealthy: boolean;
}

interface WebhookHealthResult {
  healthy: boolean;
  webhooks: WebhookStatus[];
  unhealthyWebhooks: string[];
}

const QUICKNODE_API_BASE_URL = "https://api.quicknode.com";
const HEALTHY_STATUSES = ["active"];

/**
 * Webhooks Terraform provisions in infra/quicknode.tf — keep in sync if one is
 * ever renamed or added there. Health is derived from exactly this set: each
 * expected webhook must be present (matched by name AND network, so a
 * same-named webhook on another network can't mask a deleted production one)
 * AND active. An account with zero webhooks (deleted webhooks, or an API key
 * scoped to the wrong account) therefore reports unhealthy instead of
 * "no inactive webhooks → healthy". Webhooks outside this set are reported in
 * the status list but don't affect health — they belong to other services and
 * would page the wrong on-call.
 */
const EXPECTED_WEBHOOKS = [
  { name: "SortedOracles", network: "celo-mainnet" },
  { name: "MentoGovernor", network: "celo-mainnet" },
];

/**
 * The webhooks endpoint is paginated (default limit 20), so we page through
 * every result — an expected webhook beyond the first page must not be
 * reported as missing.
 */
const WEBHOOKS_PAGE_LIMIT = 100;

/** Timeout for QuickNode API requests (30 seconds) */
const QUICKNODE_API_TIMEOUT_MS = 30_000;

function isExpectedWebhook(webhook: QuicknodeWebhook): boolean {
  return EXPECTED_WEBHOOKS.some(
    (expected) =>
      expected.name === webhook.name && expected.network === webhook.network,
  );
}

/**
 * Checks the health status of all QuickNode webhooks.
 * Returns information about each webhook's status and whether it's healthy.
 */
export const checkWebhookStatus = async (): Promise<WebhookHealthResult> => {
  const startTime = Date.now();

  // Get API key from Secret Manager
  let apiKey: string;
  const secretStartTime = Date.now();
  try {
    apiKey = await getSecret(config.QUICKNODE_API_KEY_SECRET_ID);
  } catch (error) {
    const secretDuration = Date.now() - secretStartTime;
    throw new Error(
      `Failed to retrieve QuickNode API key from Secret Manager after ${String(secretDuration)}ms: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const secretDuration = Date.now() - secretStartTime;

  // Call QuickNode API with timeout, paging through all results
  const fetchStartTime = Date.now();
  const webhooks: QuicknodeWebhook[] = [];
  let offset = 0;

  for (;;) {
    let response: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, QUICKNODE_API_TIMEOUT_MS);

      response = await fetch(
        `${QUICKNODE_API_BASE_URL}/webhooks/rest/v1/webhooks?limit=${String(WEBHOOKS_PAGE_LIMIT)}&offset=${String(offset)}`,
        {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);
    } catch (error) {
      const fetchDuration = Date.now() - fetchStartTime;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      throw new Error(
        `QuickNode API request failed after ${String(fetchDuration)}ms (secretFetch=${String(secretDuration)}ms): ${
          isTimeout
            ? `Request timed out after ${String(QUICKNODE_API_TIMEOUT_MS)}ms`
            : error instanceof Error
              ? error.message
              : String(error)
        }`,
      );
    }

    if (!response.ok) {
      const fetchDuration = Date.now() - fetchStartTime;
      const totalDuration = Date.now() - startTime;
      throw new Error(
        `QuickNode API returned ${String(response.status)} ${response.statusText} after ${String(fetchDuration)}ms (total=${String(totalDuration)}ms, secretFetch=${String(secretDuration)}ms)`,
      );
    }

    const page = (await response.json()) as QuicknodeWebhooksResponse;
    webhooks.push(...page.data);

    if (page.data.length < WEBHOOKS_PAGE_LIMIT) {
      break;
    }
    offset += WEBHOOKS_PAGE_LIMIT;
  }

  const webhookStatuses = webhooks.map((webhook) => ({
    name: webhook.name,
    status: webhook.status,
    isHealthy: HEALTHY_STATUSES.includes(webhook.status.toLowerCase()),
  }));

  const missingWebhooks = EXPECTED_WEBHOOKS.filter(
    (expected) =>
      !webhooks.some(
        (webhook) =>
          webhook.name === expected.name &&
          webhook.network === expected.network,
      ),
  );

  const unhealthyWebhooks = [
    ...missingWebhooks.map((expected) => `${expected.name} (missing)`),
    ...webhooks
      .filter(
        (webhook) =>
          isExpectedWebhook(webhook) &&
          !HEALTHY_STATUSES.includes(webhook.status.toLowerCase()),
      )
      .map((webhook) => `${webhook.name} (${webhook.status})`),
  ];

  return {
    healthy: unhealthyWebhooks.length === 0,
    webhooks: webhookStatuses,
    unhealthyWebhooks,
  };
};
