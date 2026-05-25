import crypto from "crypto";
import { logger } from "./logger";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const STORAGE_UPLOAD_BASE_URL =
  "https://storage.googleapis.com/upload/storage/v1/b";

type Fetch = typeof fetch;

type ReplayProtectionResult =
  | { valid: true }
  | { valid: false; status: number; message: string };

interface ReplayProtectionOptions {
  bucketName?: string;
  fetchImpl?: Fetch;
}

export async function reserveQuickNodeNonce(
  nonce: string,
  timestamp: string,
  options: ReplayProtectionOptions = {},
): Promise<ReplayProtectionResult> {
  const bucketName =
    options.bucketName ?? process.env.QUICKNODE_REPLAY_BUCKET ?? "";
  if (!bucketName) {
    logger.error("QUICKNODE_REPLAY_BUCKET is not configured");
    return {
      valid: false,
      status: 500,
      message: "Server configuration error",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const nonceHash = crypto
    .createHash("sha256")
    .update(`${timestamp}:${nonce}`)
    .digest("hex");
  const objectName = `quicknode-replay-nonces/${timestamp}/${nonceHash}.json`;

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
        timestamp,
        nonceHash,
      }),
    });

    if (response.status === 412) {
      logger.warn("Rejected replayed QuickNode webhook nonce", {
        timestamp,
        nonceHash,
      });
      return {
        valid: false,
        status: 401,
        message: "Unauthorized: Replayed webhook nonce",
      };
    }

    if (!response.ok) {
      logger.error("Failed to reserve QuickNode webhook nonce", {
        status: response.status,
        statusText: response.statusText,
        timestamp,
        nonceHash,
      });
      return {
        valid: false,
        status: 500,
        message: "Server configuration error",
      };
    }
  } catch (error) {
    logger.error("QuickNode replay protection failed", {
      error: error instanceof Error ? error.message : String(error),
      timestamp,
      nonceHash,
    });
    return {
      valid: false,
      status: 500,
      message: "Server configuration error",
    };
  }

  return { valid: true };
}

async function getMetadataAccessToken(fetchImpl: Fetch): Promise<string> {
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

  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("metadata token response did not include access_token");
  }

  return body.access_token;
}
