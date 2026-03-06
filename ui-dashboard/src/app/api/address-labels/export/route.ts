import { NextRequest, NextResponse } from "next/server";
import { getLabels, type AddressLabelsSnapshot } from "@/lib/address-labels";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const chainId = Number(req.nextUrl.searchParams.get("chainId"));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }

  try {
    const labels = await getLabels(chainId);
    const snapshot: AddressLabelsSnapshot = {
      exportedAt: new Date().toISOString(),
      chains: { [String(chainId)]: labels },
    };
    const filename = `address-labels-chain-${chainId}-${new Date().toISOString().slice(0, 10)}.json`;
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
