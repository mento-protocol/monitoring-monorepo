import { NextResponse } from "next/server";
import { type ApiErrorBody } from "@/lib/api-failure";
import { fetchPegDecisionPackages } from "@/lib/peg-monitoring-upstream";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" } as const;

export async function GET(): Promise<NextResponse> {
  const result = await fetchPegDecisionPackages();
  if (result.ok) return NextResponse.json(result.data, { headers });
  const body: ApiErrorBody = {
    error: result.message,
    failureClass: result.failureClass,
    ...(result.upstreamStatus === undefined
      ? {}
      : { upstreamStatus: result.upstreamStatus }),
  };
  return NextResponse.json(body, { status: result.status, headers });
}
