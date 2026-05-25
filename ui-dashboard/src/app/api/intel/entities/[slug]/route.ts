import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { ALLOWED_DOMAIN, getAuthSession } from "@/auth";
import { INTEL_ENTITY_SLUG_RE, getIntelEntity } from "@/lib/intel-entities";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
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

    const { slug } = await params;

    if (!INTEL_ENTITY_SLUG_RE.test(slug)) {
      return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
    }

    const record = await getIntelEntity(slug);
    if (record === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(record);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "intel/entities" } });
    console.error("[intel/entities]", err);
    return NextResponse.json(
      { error: "Failed to read intel entity record" },
      { status: 500 },
    );
  }
}
