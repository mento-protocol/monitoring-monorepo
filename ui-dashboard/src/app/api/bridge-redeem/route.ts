import { NextRequest, NextResponse } from "next/server";
import {
  getChainRedeemConfig,
  getTransceiverForToken,
  vaaBase64ToHex,
  type BridgeRedeemPayload,
} from "@/lib/bridge-flows/redeem";

type WormholeOperation = {
  vaa?: { raw?: string };
};

type WormholeOperationResponse = {
  operations?: WormholeOperation[];
};

type RedeemRequest = {
  txHash: string;
  chainConfig: NonNullable<ReturnType<typeof getChainRedeemConfig>>;
  transceiver: NonNullable<ReturnType<typeof getTransceiverForToken>>;
};

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function parseRedeemRequest(
  request: NextRequest,
): { ok: true; value: RedeemRequest } | { ok: false; response: NextResponse } {
  const txHash = request.nextUrl.searchParams.get("txHash")?.trim() ?? "";
  const destChainId = Number(
    request.nextUrl.searchParams.get("destChainId") ?? "",
  );
  const tokenSymbol =
    request.nextUrl.searchParams.get("tokenSymbol")?.trim() ?? "";

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return {
      ok: false,
      response: badRequest("Expected a 32-byte hex txHash."),
    };
  }
  if (!Number.isFinite(destChainId) || destChainId === 0) {
    return {
      ok: false,
      response: badRequest("Expected a numeric destChainId."),
    };
  }
  const chainConfig = getChainRedeemConfig(destChainId);
  if (!chainConfig) {
    return {
      ok: false,
      response: badRequest(`Unsupported destination chain: ${destChainId}.`),
    };
  }
  const transceiver = getTransceiverForToken(destChainId, tokenSymbol);
  if (!transceiver) {
    return {
      ok: false,
      response: badRequest(`Unknown token symbol: ${tokenSymbol}.`),
    };
  }
  return { ok: true, value: { txHash, chainConfig, transceiver } };
}

export async function GET(request: NextRequest) {
  const parsed = parseRedeemRequest(request);
  if (!parsed.ok) return parsed.response;
  const { txHash, chainConfig, transceiver } = parsed.value;

  const url = new URL("https://api.wormholescan.io/api/v1/operations");
  url.searchParams.set("page", "0");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("sortOrder", "ASC");
  url.searchParams.set("txHash", txHash);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return badRequest("Wormholescan lookup timed out or failed.", 502);
  }

  if (!response.ok) {
    return badRequest(
      `Wormholescan lookup failed with status ${response.status}.`,
      502,
    );
  }

  let body: WormholeOperationResponse;
  try {
    body = (await response.json()) as WormholeOperationResponse;
  } catch {
    return badRequest("Wormholescan returned an invalid response.", 502);
  }
  const operations = parseOperations(body);
  if (!operations) {
    return badRequest("Wormholescan returned an invalid response.", 502);
  }

  const vaaSelection = getSingleVaaRaw(operations);
  if (!vaaSelection.ok) return vaaSelection.response;

  const vaaHex = decodeVaaHex(vaaSelection.vaaRaw);
  if (!vaaHex) {
    return badRequest("Wormholescan returned an invalid VAA.", 502);
  }

  const payload: BridgeRedeemPayload = {
    chainId: chainConfig.chainId,
    chainIdHex: chainConfig.chainIdHex,
    chainName: chainConfig.chainName,
    rpcUrl: chainConfig.rpcUrl,
    explorerUrl: chainConfig.explorerUrl,
    nativeCurrency: chainConfig.nativeCurrency,
    transceiver,
    vaaHex,
  };

  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}

function isValidBase64(value: string): boolean {
  return (
    value.length % 4 !== 1 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    !/=.+[^=]/.test(value)
  );
}

function decodeVaaHex(vaaRaw: string): `0x${string}` | null {
  if (!isValidBase64(vaaRaw)) return null;
  try {
    return vaaBase64ToHex(vaaRaw);
  } catch {
    return null;
  }
}

function getSingleVaaRaw(
  operations: WormholeOperation[],
): { ok: true; vaaRaw: string } | { ok: false; response: NextResponse } {
  if (operations.length === 0) {
    return {
      ok: false,
      response: badRequest(
        "No Wormhole VAA found for this source transaction.",
        404,
      ),
    };
  }
  if (operations.length > 1) {
    return {
      ok: false,
      response: badRequest(
        "Multiple Wormhole messages found for this transaction; manual redemption is not supported for batch transfers.",
        400,
      ),
    };
  }

  const vaaRaw = operations[0].vaa?.raw;
  if (!vaaRaw || vaaRaw.length === 0) {
    return {
      ok: false,
      response: badRequest(
        "No Wormhole VAA found for this source transaction.",
        404,
      ),
    };
  }
  return { ok: true, vaaRaw };
}

function parseOperations(
  body: WormholeOperationResponse,
): WormholeOperation[] | null {
  if (!isRecord(body)) return null;
  if (body.operations === undefined) return [];
  if (!Array.isArray(body.operations)) return null;

  const operations: WormholeOperation[] = [];
  for (const operation of body.operations) {
    if (!isRecord(operation)) return null;
    if (operation.vaa !== undefined && !isRecord(operation.vaa)) return null;
    operations.push(operation as WormholeOperation);
  }

  return operations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
