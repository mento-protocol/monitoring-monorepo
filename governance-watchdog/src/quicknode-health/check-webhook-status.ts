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

/** Timeout for QuickNode API requests (30 seconds) */
const QUICKNODE_API_TIMEOUT_MS = 30_000;

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
    apiKey = await getSecret(
      process.env.QUICKNODE_API_KEY_SECRET_ID ?? "quicknode-api-key",
    );
  } catch (error) {
    const secretDuration = Date.now() - secretStartTime;
    throw new Error(
      `Failed to retrieve QuickNode API key from Secret Manager after ${String(secretDuration)}ms: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const secretDuration = Date.now() - secretStartTime;

  // Call QuickNode API with timeout
  const fetchStartTime = Date.now();
  let response: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, QUICKNODE_API_TIMEOUT_MS);

    response = await fetch(
      `${QUICKNODE_API_BASE_URL}/webhooks/rest/v1/webhooks`,
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
  const fetchDuration = Date.now() - fetchStartTime;

  if (!response.ok) {
    const totalDuration = Date.now() - startTime;
    throw new Error(
      `QuickNode API returned ${String(response.status)} ${response.statusText} after ${String(fetchDuration)}ms (total=${String(totalDuration)}ms, secretFetch=${String(secretDuration)}ms)`,
    );
  }

  const data = (await response.json()) as QuicknodeWebhooksResponse;
  const webhooks = data.data;

  const webhookStatuses = webhooks.map((webhook) => ({
    name: webhook.name,
    status: webhook.status,
    isHealthy: HEALTHY_STATUSES.includes(webhook.status.toLowerCase()),
  }));

  const unhealthyWebhooks = webhookStatuses
    .filter((w) => !w.isHealthy)
    .map((w) => `${w.name} (${w.status})`);

  return {
    healthy: unhealthyWebhooks.length === 0,
    webhooks: webhookStatuses,
    unhealthyWebhooks,
  };
};
