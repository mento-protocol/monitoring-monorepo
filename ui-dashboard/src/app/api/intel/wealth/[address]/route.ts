import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { getIntelWealth } from "@/lib/intel-wealth";
import { isValidAddress } from "@/lib/format";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
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

  try {
    const record = await getIntelWealth(address);
    if (record === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(record);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "intel/wealth" } });
    console.error("[intel/wealth]", err);
    return NextResponse.json(
      { error: "Failed to read intel wealth record" },
      { status: 500 },
    );
  }
}
