import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { ALLOWED_DOMAIN, auth } from "@/auth";
import { getLabels, type AddressLabelsSnapshot } from "@/lib/address-labels";
import { getAllReports } from "@/lib/address-reports";

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  // Reject both missing sessions and ones flagged with a RefreshTokenError
  // (revoked/offboarded Google account). Middleware already gates this path,
  // but this export dumps every label + forensic report, so it re-checks
  // in-route rather than trusting the matcher alone.
  if (!session || session.error) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const email = session.user?.email?.toLowerCase();
  if (!email?.endsWith(ALLOWED_DOMAIN)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // Single flat export — labels are no longer chain-scoped, so the
    // legacy `?chainId=` filter has no meaning. Old snapshots with
    // `chains` / `global` fields stay readable on the import side via
    // the AddressLabelsSnapshot back-compat shape.
    //
    // Forensic reports ride along under `reports` so the user-facing
    // export is symmetric with the daily backup — a maintainer-driven
    // export-then-reimport cycle preserves both halves.
    const [labels, reports] = await Promise.all([getLabels(), getAllReports()]);
    const snapshot: AddressLabelsSnapshot = {
      exportedAt: new Date().toISOString(),
      addresses: labels,
      reports,
    };
    const filename = `address-labels-${new Date().toISOString().slice(0, 10)}.json`;

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
