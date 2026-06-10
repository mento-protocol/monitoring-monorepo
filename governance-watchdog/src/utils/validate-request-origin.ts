import type { Request } from "@google-cloud/functions-framework";
import crypto from "crypto";
import config from "../config";
import getSecret from "./get-secret";

export async function isFromQuicknode(req: Request): Promise<boolean> {
  const quicknodeSecurityToken = await getSecret(
    config.QUICKNODE_SECURITY_TOKEN_SECRET_ID,
  );
  const nonce = req.headers["x-qn-nonce"] as string;
  const timestamp = req.headers["x-qn-timestamp"] as string;
  const givenSignature = req.headers["x-qn-signature"] as string;

  if (!nonce || !timestamp || !givenSignature) {
    console.error("QuickNode Validation: Missing required QuickNode headers");
    return false;
  }
  try {
    // Use rawBody for signature verification - this is the original request body
    // before any parsing. Re-serializing req.body with JSON.stringify() can produce
    // different output than what was sent, causing signature verification to fail.
    if (!req.rawBody) {
      console.error(
        "❌ QuickNode Validation: req.rawBody is not available. Cannot verify signature.",
      );
      return false;
    }
    const payloadString = req.rawBody.toString();
    const isValid = verifySignature(
      quicknodeSecurityToken,
      payloadString,
      nonce,
      timestamp,
      givenSignature,
    );

    if (isValid) {
      if (process.env.DEBUG) {
        console.log("\n✅ Signature verified successfully");
      }
      return true;
    } else {
      console.error("\n❌ QuickNode signature verification failed");
      return false;
    }
  } catch (error) {
    console.error("\n❌ Error processing QuickNode webhook:", error);
    return false;
  }
}

export async function hasAuthToken(req: Request): Promise<boolean> {
  const authToken = req.headers["x-auth-token"];
  const expectedAuthToken = await getSecret(config.X_AUTH_TOKEN_SECRET_ID);

  return authToken === expectedAuthToken;
}

// Taken from https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages
function verifySignature(
  secretKey: string,
  payload: string,
  nonce: string,
  timestamp: string,
  givenSignature: string,
): boolean {
  // First concatenate signature inputs as strings
  const signatureData = nonce + timestamp + payload;

  // Use string directly instead of Buffer to avoid type errors with crypto.createHmac
  // in strict TypeScript environments (GCP build uses locked @types/node that triggers this)
  const hmac = crypto.createHmac("sha256", secretKey);
  hmac.update(signatureData);
  const computedSignature = hmac.digest("hex");

  if (process.env.DEBUG) {
    console.log("\nSignature Debug:");
    console.log("Message components:");
    console.log("- Nonce:", nonce);
    console.log("- Timestamp:", timestamp);
    console.log("- Payload first 100 chars:", payload.substring(0, 100));
    console.log("\nSignatures:");
    console.log("- Computed:", computedSignature);
    console.log("- Given:", givenSignature);
  }

  // Convert to Uint8Array manually to satisfy timingSafeEqual's ArrayBufferView requirement
  // without Buffer's type issues
  return crypto.timingSafeEqual(
    hexToBytes(computedSignature),
    hexToBytes(givenSignature),
  );
}

/**
 * Helper to convert hex string to Uint8Array.
 * We use this instead of Buffer to avoid type mismatches in newer @types/node versions,
 * which introduce stricter ArrayBufferLike checks that Buffer doesn't fully satisfy
 * (due to SharedArrayBuffer compatibility issues).
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
