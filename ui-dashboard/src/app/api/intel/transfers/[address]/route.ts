import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { getIntelTransfers } from "@/lib/intel-transfers";
import { isValidAddress } from "@/lib/format";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  try {
    const session = await getAuthSession();
    const email = session?.user?.email?.toLowerCase();
    if (!email?.endsWith(ALLOWED_DOMAIN)) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { address } = await params;

    if (!isValidAddress(address)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    const record = await getIntelTransfers(address);
    if (record === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(record);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "intel/transfers" } });
    console.error("[intel/transfers]", err);
    return NextResponse.json(
      { error: "Failed to read intel transfers record" },
      { status: 500 },
    );
  }
}
