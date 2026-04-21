import { NextRequest, NextResponse } from "next/server";
import {
  buildReceiveMessageCalldata,
  CELO_MAINNET_CHAIN_ID,
  CELO_MAINNET_CHAIN_ID_HEX,
  CELO_MAINNET_EXPLORER_URL,
  CELO_MAINNET_RPC_URL,
  vaaBase64ToHex,
  WORMHOLE_CELO_TRANSCEIVER,
  type BridgeRedeemPayload,
} from "@/lib/bridge-flows/redeem";

type WormholeOperationResponse = {
  operations?: Array<{
    vaa?: {
      raw?: string;
    };
  }>;
};

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  const txHash = request.nextUrl.searchParams.get("txHash")?.trim() ?? "";
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return badRequest("Expected a 32-byte hex txHash.");
  }

  const url = new URL("https://api.wormholescan.io/api/v1/operations");
  url.searchParams.set("page", "0");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("sortOrder", "ASC");
  url.searchParams.set("txHash", txHash);

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    return badRequest(
      `Wormholescan lookup failed with status ${response.status}.`,
      502,
    );
  }

  const body = (await response.json()) as WormholeOperationResponse;
  const vaaRaw = body.operations?.[0]?.vaa?.raw;
  if (!vaaRaw) {
    return badRequest("No Wormhole VAA found for this source transaction.", 404);
  }

  const vaaHex = vaaBase64ToHex(vaaRaw);
  const payload: BridgeRedeemPayload = {
    txHash,
    chainId: CELO_MAINNET_CHAIN_ID,
    chainIdHex: CELO_MAINNET_CHAIN_ID_HEX,
    chainName: "Celo",
    rpcUrl: CELO_MAINNET_RPC_URL,
    explorerUrl: CELO_MAINNET_EXPLORER_URL,
    transceiver: WORMHOLE_CELO_TRANSCEIVER,
    vaaHex,
    calldata: buildReceiveMessageCalldata(vaaHex),
  };

  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
