import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

function timingSafeStringEquals(a: string, b: string): boolean {
  const key = Buffer.from(b);
  const aDigest = createHmac("sha256", key).update(a).digest();
  const bDigest = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(aDigest, bDigest);
}

/**
 * Bearer-only auth gate for cron-triggered GET routes.
 *
 * Vercel cron jobs invoke handlers via HTTP GET, which is unsafe to gate on
 * session auth alone — a logged-in user could be tricked into a cross-site
 * top-level GET navigation that sends session cookies and triggers the
 * cron's expensive side effects (CSRF). Requiring `Bearer ${CRON_SECRET}`
 * ensures only the Vercel cron caller (or an explicit `curl -H Authorization`)
 * can invoke these routes; browser navigations are rejected with 401.
 *
 * In `NODE_ENV=development` the gate is bypassed so a developer can hit the
 * endpoint without secrets.
 *
 * Returns `null` on success. Returns a `NextResponse` on failure (500 if
 * `CRON_SECRET` is unset in non-dev, 401 if the bearer doesn't match).
 *
 * `routeTag` is included in the dev-only console error so misconfiguration
 * messages still identify the offending route.
 */
export async function requireCronAuth(
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

  if (
    timingSafeStringEquals(
      req.headers.get("authorization") ?? "",
      `Bearer ${cronSecret}`,
    )
  ) {
    return null;
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
