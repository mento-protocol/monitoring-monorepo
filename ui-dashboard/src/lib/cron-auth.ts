import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/auth";

/**
 * Cron-or-session auth gate.
 *
 * Cron routes accept either a `Bearer ${CRON_SECRET}` header (the Vercel
 * cron caller) or an authenticated session (a human admin manually
 * triggering the route). In `NODE_ENV=development` both gates are
 * bypassed so a developer can hit the endpoint without secrets.
 *
 * Returns `null` on success — the caller proceeds. Returns a `NextResponse`
 * to bail with on failure (500 if `CRON_SECRET` is unset in non-dev,
 * 401 if neither auth method satisfied).
 *
 * `routeTag` is included in the dev-only console error so misconfiguration
 * messages still identify the offending route.
 */
export async function requireCronOrSession(
  req: NextRequest,
  routeTag: string,
): Promise<NextResponse | null> {
  if (process.env.NODE_ENV === "development") return null;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(`[${routeTag}] CRON_SECRET is not set`);
    return NextResponse.json(
      { error: "Server misconfiguration: CRON_SECRET required" },
      { status: 500 },
    );
  }

  if (req.headers.get("authorization") === `Bearer ${cronSecret}`) {
    return null;
  }

  const session = await getAuthSession();
  if (session) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
