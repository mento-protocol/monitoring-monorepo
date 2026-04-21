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

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  const txHash = request.nextUrl.searchParams.get("txHash")?.trim() ?? "";
  const destChainId = Number(
    request.nextUrl.searchParams.get("destChainId") ?? "",
  );
  const tokenSymbol =
    request.nextUrl.searchParams.get("tokenSymbol")?.trim() ?? "";

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return badRequest("Expected a 32-byte hex txHash.");
  }
  if (!Number.isFinite(destChainId) || destChainId === 0) {
    return badRequest("Expected a numeric destChainId.");
  }
  const chainConfig = getChainRedeemConfig(destChainId);
  if (!chainConfig) {
    return badRequest(`Unsupported destination chain: ${destChainId}.`);
  }
  const transceiver = getTransceiverForToken(destChainId, tokenSymbol);
  if (!transceiver) {
    return badRequest(`Unknown token symbol: ${tokenSymbol}.`);
  }

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
  const operations = body.operations ?? [];

  if (operations.length === 0) {
    return badRequest(
      "No Wormhole VAA found for this source transaction.",
      404,
    );
  }
  if (operations.length > 1) {
    return badRequest(
      "Multiple Wormhole messages found for this transaction; manual redemption is not supported for batch transfers.",
      400,
    );
  }

  const vaaRaw = operations[0].vaa?.raw;
  if (!vaaRaw || vaaRaw.length === 0) {
    return badRequest(
      "No Wormhole VAA found for this source transaction.",
      404,
    );
  }

  const vaaHex = vaaBase64ToHex(vaaRaw);
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
