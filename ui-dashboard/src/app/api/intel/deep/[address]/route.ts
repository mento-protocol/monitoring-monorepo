import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { getIntelDeep } from "@/lib/intel-deep";
import { isValidAddress } from "@/lib/format";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  // `getAuthSession()` already filters by ALLOWED_DOMAIN, but we recheck
  // here so the policy is explicit at the route boundary — a future
  // refactor of the helper can't silently widen access to this surface.
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
    const record = await getIntelDeep(address);
    if (record === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(record);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "intel/deep" } });
    console.error("[intel/deep]", err);
    return NextResponse.json(
      { error: "Failed to read intel deep record" },
      { status: 500 },
    );
  }
}
