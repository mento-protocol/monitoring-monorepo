import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAuthSession } from "@/auth";
import {
  getLabels,
  getAllLabels,
  type AddressLabelsSnapshot,
} from "@/lib/address-labels";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const chainIdParam = req.nextUrl.searchParams.get("chainId");

  try {
    let snapshot: AddressLabelsSnapshot;
    let filename: string;

    if (chainIdParam !== null) {
      // Legacy: export a single chain by chainId — no global included.
      // Strict decimal-only parse matches the rest of the codebase so
      // `?chainId=1e3` doesn't silently resolve to chainId 1000.
      if (!/^\d+$/.test(chainIdParam)) {
        return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
      }
      const chainId = Number(chainIdParam);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
      }
      const labels = await getLabels(chainId);
      snapshot = {
        exportedAt: new Date().toISOString(),
        chains: { [String(chainId)]: labels },
      };
      filename = `address-labels-chain-${chainId}-${new Date().toISOString().slice(0, 10)}.json`;
    } else {
      // Export all scopes — global + every chain.
      const { global, chains } = await getAllLabels();
      snapshot = {
        exportedAt: new Date().toISOString(),
        global,
        chains,
      };
      filename = `address-labels-all-${new Date().toISOString().slice(0, 10)}.json`;
    }

    return new NextResponse(JSON.stringify(snapshot, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    // Full error is in Sentry; return a generic string to the client.
    Sentry.captureException(err, { tags: { route: "address-labels/export" } });
    console.error("[address-labels/export]", err);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
