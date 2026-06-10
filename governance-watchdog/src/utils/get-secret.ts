import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import config from "../config.js";

/**
 * Singleton gRPC client — creating a new SecretManagerServiceClient per request
 * leaks gRPC channels and causes memory growth (~488 MiB OOM within 30 min).
 * One client is created at module load time and reused for all requests.
 *
 * Note: we intentionally do NOT cache secret values here. Caching `versions/latest`
 * would break secret rotation — rotated credentials would not take effect until Cloud
 * Run recycles the instance. The singleton client alone eliminates the gRPC leak.
 */
const secretManager = new SecretManagerServiceClient();

/**
 * Load a secret from Secret Manager.
 * Uses a singleton gRPC client to prevent channel leaks on warm instances.
 */
export default async function getSecret(secretId: string): Promise<string> {
  try {
    const secretFullResourceName = `projects/${config.GCP_PROJECT_ID}/secrets/${secretId}/versions/latest`;
    const [version] = await secretManager.accessSecretVersion({
      name: secretFullResourceName,
    });

    const secret = version.payload?.data?.toString();

    if (!secret) {
      throw new Error(
        `Secret '${secretId}' is empty or undefined. Please check the secret in Secret Manager.`,
      );
    }

    return secret;
  } catch (error) {
    console.error(
      `Failed to retrieve secret '${secretId}' from secret manager:`,
      error,
    );
    throw error;
  }
}
