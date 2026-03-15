import { NextRequest, NextResponse } from "next/server";
import {
  getLabels,
  getAllChainLabels,
  type AddressLabelEntry,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const chainIdParam = req.nextUrl.searchParams.get("chainId");

  try {
    let chains: Record<string, Record<string, AddressLabelEntry>>;
    let filename: string;

    if (chainIdParam !== null) {
      // Legacy: export a single chain by chainId
      const chainId = Number(chainIdParam);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
      }
      const labels = await getLabels(chainId);
      chains = { [String(chainId)]: labels };
      filename = `address-labels-chain-${chainId}-${new Date().toISOString().slice(0, 10)}.json`;
    } else {
      // Export all chains
      chains = await getAllChainLabels();
      filename = `address-labels-all-${new Date().toISOString().slice(0, 10)}.json`;
    }

    const snapshot: AddressLabelsSnapshot = {
      exportedAt: new Date().toISOString(),
      chains,
    };

    return new NextResponse(JSON.stringify(snapshot, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[address-labels/export]", err);
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
