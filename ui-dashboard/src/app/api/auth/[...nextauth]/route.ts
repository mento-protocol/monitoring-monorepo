import { handlers } from "@/auth";
import { NextResponse } from "next/server";

export const { GET, POST } = handlers;

// Health-check probes (uptime monitors, curl) often send HEAD requests to
// auth endpoints. Auth.js only handles GET and POST; without an explicit HEAD
// export Next.js forwards the HEAD to the GET handler which then throws
// UnknownAction ("Only GET and POST are supported"). Returning 200 with no
// body satisfies probes without hitting auth.js internals.
export function HEAD() {
  return new NextResponse(null, { status: 200 });
}
