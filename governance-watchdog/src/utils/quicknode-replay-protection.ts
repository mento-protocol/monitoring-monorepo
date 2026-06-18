import crypto from "crypto";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const STORAGE_UPLOAD_BASE_URL =
  "https://storage.googleapis.com/upload/storage/v1/b";
const METADATA_TOKEN_REFRESH_SKEW_MS = 60_000;

type Fetch = typeof fetch;

type ReplayProtectionResult =
  | { valid: true; skipped?: string }
  | { valid: false; status: number; message: string; replayed?: boolean };

interface ReplayProtectionOptions {
  bucketName?: string;
  fetchImpl?: Fetch;
}

let cachedMetadataToken:
  | { accessToken: string; expiresAtMs: number }
  | undefined;

export async function reserveQuickNodeNonce(
  nonce: string,
  timestamp: string,
  options: ReplayProtectionOptions = {},
): Promise<ReplayProtectionResult> {
  const bucketName =
    options.bucketName ?? process.env.QUICKNODE_REPLAY_BUCKET ?? "";
  if (!bucketName) {
    // Degrade open: without a configured bucket we cannot dedupe, but failing
    // every signed webhook (500) would drop governance alerts. Process the
    // webhook and surface the misconfiguration so the call site can page.
    return { valid: true, skipped: "QUICKNODE_REPLAY_BUCKET not configured" };
  }

  const {
    fetchImpl,
    objectName,
    timestamp: requestTimestamp,
    nonceHash,
  } = replayProtectionSetup(nonce, timestamp, bucketName, options);

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
      console.warn("Rejected replayed QuickNode webhook nonce", {
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
      console.error("Failed to reserve QuickNode webhook nonce", {
        status: response.status,
        statusText: response.statusText,
        timestamp: requestTimestamp,
        nonceHash,
      });
      return serverConfigurationError();
    }
  } catch (error) {
    console.error("QuickNode replay protection failed", {
      error: error instanceof Error ? error.message : String(error),
      timestamp: requestTimestamp,
      nonceHash,
    });
    return serverConfigurationError();
  }

  return { valid: true };
}

function replayProtectionSetup(
  nonce: string,
  timestamp: string,
  bucketName: string,
  options: ReplayProtectionOptions,
): {
  fetchImpl: Fetch;
  objectName: string;
  timestamp: string;
  nonceHash: string;
} {
  const nonceHash = crypto
    .createHash("sha256")
    .update(`${timestamp}:${nonce}`)
    .digest("hex");

  return {
    fetchImpl: options.fetchImpl ?? fetch,
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
      `metadata token request failed: ${String(response.status)} ${response.statusText}`,
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
