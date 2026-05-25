import crypto from "crypto";
import { logger } from "./logger";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const STORAGE_OBJECT_BASE_URL = "https://storage.googleapis.com/storage/v1/b";
const STORAGE_UPLOAD_BASE_URL =
  "https://storage.googleapis.com/upload/storage/v1/b";
const METADATA_TOKEN_REFRESH_SKEW_MS = 60_000;

type Fetch = typeof fetch;

type ReplayProtectionResult =
  | { valid: true }
  | { valid: false; status: number; message: string; replayed?: boolean };

interface ReplayProtectionOptions {
  bucketName?: string;
  fetchImpl?: Fetch;
}

let cachedMetadataToken:
  | { accessToken: string; expiresAtMs: number }
  | undefined;

export async function checkQuickNodeNonce(
  nonce: string,
  timestamp: string,
  options: ReplayProtectionOptions = {},
): Promise<ReplayProtectionResult> {
  const setup = await replayProtectionSetup(nonce, timestamp, options);
  if (!setup.valid) return setup;

  const {
    fetchImpl,
    bucketName,
    objectName,
    timestamp: requestTimestamp,
    nonceHash,
  } = setup;

  try {
    const accessToken = await getMetadataAccessToken(fetchImpl);
    const objectUrl = `${STORAGE_OBJECT_BASE_URL}/${encodeURIComponent(
      bucketName,
    )}/o/${encodeURIComponent(objectName)}`;
    const response = await fetchImpl(objectUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status === 404) return { valid: true };

    if (response.ok) {
      logger.warn("Acknowledged replayed QuickNode webhook nonce", {
        timestamp: requestTimestamp,
        nonceHash,
      });
      return {
        valid: false,
        status: 200,
        message: "Duplicate webhook nonce already processed",
        replayed: true,
      };
    }

    logger.error("Failed to check QuickNode webhook nonce", {
      status: response.status,
      statusText: response.statusText,
      timestamp: requestTimestamp,
      nonceHash,
    });
    return serverConfigurationError();
  } catch (error) {
    logger.error("QuickNode replay protection check failed", {
      error: error instanceof Error ? error.message : String(error),
      timestamp: requestTimestamp,
      nonceHash,
    });
    return serverConfigurationError();
  }
}

export async function reserveQuickNodeNonce(
  nonce: string,
  timestamp: string,
  options: ReplayProtectionOptions = {},
): Promise<ReplayProtectionResult> {
  const setup = await replayProtectionSetup(nonce, timestamp, options);
  if (!setup.valid) return setup;

  const {
    fetchImpl,
    bucketName,
    objectName,
    timestamp: requestTimestamp,
    nonceHash,
  } = setup;

  try {
    const accessToken = await getMetadataAccessToken(fetchImpl);
    const uploadUrl = new URL(
      `${STORAGE_UPLOAD_BASE_URL}/${encodeURIComponent(bucketName)}/o`,
    );
    uploadUrl.searchParams.set("uploadType", "media");
    uploadUrl.searchParams.set("name", objectName);
    uploadUrl.searchParams.set("ifGenerationMatch", "0");

    const response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receivedAt: new Date().toISOString(),
        timestamp: requestTimestamp,
        nonceHash,
      }),
    });

    if (response.status === 412) {
      logger.warn("Rejected replayed QuickNode webhook nonce", {
        timestamp: requestTimestamp,
        nonceHash,
      });
      return {
        valid: false,
        status: 200,
        message: "Duplicate webhook nonce already processed",
        replayed: true,
      };
    }

    if (!response.ok) {
      logger.error("Failed to reserve QuickNode webhook nonce", {
        status: response.status,
        statusText: response.statusText,
        timestamp: requestTimestamp,
        nonceHash,
      });
      return serverConfigurationError();
    }
  } catch (error) {
    logger.error("QuickNode replay protection failed", {
      error: error instanceof Error ? error.message : String(error),
      timestamp: requestTimestamp,
      nonceHash,
    });
    return serverConfigurationError();
  }

  return { valid: true };
}

async function replayProtectionSetup(
  nonce: string,
  timestamp: string,
  options: ReplayProtectionOptions,
): Promise<
  | {
      valid: true;
      fetchImpl: Fetch;
      bucketName: string;
      objectName: string;
      timestamp: string;
      nonceHash: string;
    }
  | { valid: false; status: number; message: string }
> {
  const bucketName =
    options.bucketName ?? process.env.QUICKNODE_REPLAY_BUCKET ?? "";
  if (!bucketName) {
    logger.error("QUICKNODE_REPLAY_BUCKET is not configured");
    return serverConfigurationError();
  }

  const nonceHash = crypto
    .createHash("sha256")
    .update(`${timestamp}:${nonce}`)
    .digest("hex");

  return {
    valid: true,
    fetchImpl: options.fetchImpl ?? fetch,
    bucketName,
    objectName: `quicknode-replay-nonces/${timestamp}/${nonceHash}.json`,
    timestamp,
    nonceHash,
  };
}

async function getMetadataAccessToken(fetchImpl: Fetch): Promise<string> {
  if (
    cachedMetadataToken &&
    cachedMetadataToken.expiresAtMs - METADATA_TOKEN_REFRESH_SKEW_MS >
      Date.now()
  ) {
    return cachedMetadataToken.accessToken;
  }

  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: {
      "metadata-flavor": "Google",
    },
  });

  if (!response.ok) {
    throw new Error(
      `metadata token request failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("metadata token response did not include access_token");
  }
  const expiresInSeconds =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 300;
  cachedMetadataToken = {
    accessToken: body.access_token,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };

  return body.access_token;
}

function serverConfigurationError(): {
  valid: false;
  status: number;
  message: string;
} {
  return {
    valid: false,
    status: 500,
    message: "Server configuration error",
  };
}
