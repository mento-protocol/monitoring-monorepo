import { NextResponse } from "next/server";
import { fetchReserveYieldSnapshot } from "@/lib/reserve-yield";

export async function GET(): Promise<NextResponse> {
  try {
    const snapshot = await fetchReserveYieldSnapshot();
    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "s-maxage=300, stale-while-revalidate=900",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Reserve yield unavailable: ${message}` },
      { status: 500 },
    );
  }
}
