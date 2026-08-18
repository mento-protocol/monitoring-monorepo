import { NextResponse } from "next/server";
import { type ApiErrorBody } from "@/lib/api-failure";
import { fetchPegDecisionPackages } from "@/lib/peg-monitoring-upstream";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" } as const;

// Re-exported so the response ceiling and the upstream timeout stay
// addressable at the route path they were introduced at. The implementations
// live in lib/peg-monitoring-upstream.ts, shared with the route's OG card.
export {
  PEG_MONITORING_MAX_RESPONSE_BYTES,
  PEG_MONITORING_UPSTREAM_TIMEOUT_MS,
} from "@/lib/peg-monitoring-upstream";

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
