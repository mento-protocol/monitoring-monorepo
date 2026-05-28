import type { Request } from "@google-cloud/functions-framework";
import {
  AbiEventSignatureNotFoundError,
  decodeEventLog,
  type Abi,
  type Hex,
} from "viem";
import { logger } from "./logger";
import type { QuickNodeWebhookPayload } from "./types";
import safeAbi from "./safe-abi.json";

type PayloadValidationResult =
  | { valid: true; payload: QuickNodeWebhookPayload }
  | { valid: false; status: number; error: { error: string } };

/**
 * Validate QuickNode webhook payload structure
 * Ensures the request body contains a valid result array
 *
 * @param req - The incoming HTTP request
 * @returns Validation result with parsed payload if valid
 */
export function validatePayload(req: Request): PayloadValidationResult {
  // QuickNode envelope varies by API era:
  //   - Pre-template (custom filter_function): `{ result: [...] }` — the
  //     filter function explicitly returned this shape.
  //   - Template-based (evmContractEvents, evmAbiFilter, etc.): may deliver
  //     `{ data: [...], metadata: {...} }` per the Webhooks envelope.
  //   - evmContractEvents currently delivers raw transaction receipts as
  //     `{ matchingReceipts: [...] }`.
  // We accept all shapes and normalize to `result` so the rest of the handler
  // stays a single code path. The top-level keys are checked in priority
  // order — if multiple appear, the already-decoded shapes win.
  const body = req.body as
    | { result?: unknown; data?: unknown; matchingReceipts?: unknown }
    | null
    | undefined;

  const rawArray =
    body && Array.isArray(body.result)
      ? body.result
      : body && Array.isArray(body.data)
        ? body.data
        : body && Array.isArray(body.matchingReceipts)
          ? normalizeMatchingReceipts(body.matchingReceipts)
          : null;

  if (!rawArray) {
    // Don't log req.body. Even though signature verification has already
    // passed at this point, a malformed payload could still be large or
    // contain sensitive multisig-event data that bloats Cloud Logging.
    // The shape diagnostic below is enough to debug real producer bugs.
    logger.error("Invalid webhook payload: no supported event array present", {
      hasBody: req.body !== undefined,
      bodyType: typeof req.body,
      topLevelKeys: body && typeof body === "object" ? Object.keys(body) : null,
      resultIsArray: Array.isArray(body?.result),
      dataIsArray: Array.isArray(body?.data),
      matchingReceiptsIsArray: Array.isArray(body?.matchingReceipts),
    });
    return {
      valid: false,
      status: 400,
      error: {
        error:
          "Invalid payload: result, data, or matchingReceipts array is required",
      },
    };
  }

  // Normalize to the canonical `result` shape. The QuickNodeWebhookPayload
  // type stays `{ result: QuickNodeDecodedLog[] }`; downstream code is
  // agnostic to whether the wire-level envelope was `data` or `result`.
  const payload = {
    result: rawArray as QuickNodeWebhookPayload["result"],
  } satisfies QuickNodeWebhookPayload;

  return { valid: true, payload };
}

type RawReceipt = Record<string, unknown> & {
  logs?: unknown;
  transactionHash?: unknown;
  blockHash?: unknown;
  blockNumber?: unknown;
};

type RawLog = Record<string, unknown> & {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  transactionHash?: unknown;
  blockHash?: unknown;
  blockNumber?: unknown;
  logIndex?: unknown;
};

function normalizeMatchingReceipts(
  receipts: unknown[],
): QuickNodeWebhookPayload["result"] {
  const logs: QuickNodeWebhookPayload["result"] = [];

  for (const receipt of receipts) {
    if (!isObject(receipt) || !Array.isArray(receipt.logs)) {
      continue;
    }

    for (const rawLog of receipt.logs) {
      if (!isObject(rawLog)) {
        continue;
      }

      const decodedLog = decodeRawSafeLog(rawLog, receipt);
      if (decodedLog) {
        logs.push(decodedLog);
      }
    }
  }

  return logs;
}

function decodeRawSafeLog(
  rawLog: RawLog,
  receipt: RawReceipt,
): QuickNodeWebhookPayload["result"][number] | null {
  if (
    typeof rawLog.address !== "string" ||
    !Array.isArray(rawLog.topics) ||
    rawLog.topics.length === 0 ||
    !rawLog.topics.every((topic): topic is Hex => isHexString(topic)) ||
    (rawLog.data !== undefined && !isHexString(rawLog.data))
  ) {
    return null;
  }

  try {
    const decoded = decodeEventLog({
      abi: safeAbi as Abi,
      data: (typeof rawLog.data === "string" ? rawLog.data : "0x") as Hex,
      topics: rawLog.topics as [Hex, ...Hex[]],
    });

    if (!decoded.eventName) {
      return null;
    }

    const transactionHash = pickString(
      rawLog.transactionHash,
      receipt.transactionHash,
    );
    const blockHash = pickString(rawLog.blockHash, receipt.blockHash);
    const blockNumber = pickString(rawLog.blockNumber, receipt.blockNumber);
    const logIndex = pickString(rawLog.logIndex);

    if (!transactionHash || !blockHash || !blockNumber || !logIndex) {
      logger.warn("Dropping Safe log: missing required metadata fields", {
        address: rawLog.address,
        topic0: rawLog.topics[0],
        hasTransactionHash: Boolean(transactionHash),
        hasBlockHash: Boolean(blockHash),
        hasBlockNumber: Boolean(blockNumber),
        hasLogIndex: Boolean(logIndex),
      });
      return null;
    }

    return {
      ...normalizeDecodedArgs(decoded.args),
      address: rawLog.address,
      name: decoded.eventName,
      transactionHash,
      blockHash,
      blockNumber,
      logIndex,
    };
  } catch (err) {
    if (!isExpectedNonSafeEventError(err)) {
      logger.warn("Unexpected error decoding log against Safe ABI", {
        error: err instanceof Error ? err.message : String(err),
        address: rawLog.address,
        topic0: rawLog.topics[0],
      });
    }
    return null;
  }
}

function isExpectedNonSafeEventError(err: unknown): boolean {
  return (
    err instanceof AbiEventSignatureNotFoundError ||
    (err instanceof Error && err.name === "AbiEventSignatureNotFoundError")
  );
}

function normalizeDecodedArgs(args: unknown): Record<string, unknown> {
  if (!isObject(args) || Array.isArray(args)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      normalizeDecodedValue(value),
    ]),
  );
}

function normalizeDecodedValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDecodedValue);
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeDecodedValue(child),
      ]),
    );
  }

  return value;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isHexString(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}
