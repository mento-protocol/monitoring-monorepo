import { NextRequest, NextResponse } from "next/server";

type LocalNetworkId = "devnet" | "celo-sepolia-local" | "celo-mainnet-local";

type LocalHasuraConfig = {
  upstreamUrl: string;
  adminSecret: string;
};

function resolveLocalHasuraConfig(networkId: string): LocalHasuraConfig | null {
  switch (networkId as LocalNetworkId) {
    case "devnet":
      return {
        upstreamUrl:
          process.env.HASURA_UPSTREAM_URL_DEVNET?.trim() ||
          "http://localhost:8080/v1/graphql",
        adminSecret: process.env.HASURA_SECRET_DEVNET?.trim() ?? "",
      };
    case "celo-sepolia-local":
      return {
        upstreamUrl:
          process.env.HASURA_UPSTREAM_URL_CELO_SEPOLIA_LOCAL?.trim() ||
          "http://localhost:8080/v1/graphql",
        adminSecret: process.env.HASURA_SECRET_CELO_SEPOLIA_LOCAL?.trim() ?? "",
      };
    case "celo-mainnet-local":
      return {
        upstreamUrl:
          process.env.HASURA_UPSTREAM_URL_CELO_MAINNET_LOCAL?.trim() ||
          "http://localhost:8080/v1/graphql",
        adminSecret: process.env.HASURA_SECRET_CELO_MAINNET_LOCAL?.trim() ?? "",
      };
    default:
      return null;
  }
}

// Belt-and-suspenders: this proxy only exists to give local dev a way to
// forward the admin secret to a locally-running Hasura without leaking it
// into the browser bundle. If `HASURA_SECRET_*` is ever misconfigured on a
// production/preview deploy (Vercel auto-sets `NODE_ENV=production` for both),
// an unauthenticated caller could otherwise run admin queries through us —
// so refuse outright. Vitest sets `NODE_ENV=test`, so tests still exercise
// the handler.
function isProxyEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ networkId: string }> },
): Promise<Response> {
  if (!isProxyEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { networkId } = await params;
  const config = resolveLocalHasuraConfig(networkId);
  if (!config) {
    return NextResponse.json({ error: "Unsupported network" }, { status: 404 });
  }

  const body = await req.text();
  const headers = new Headers({
    "content-type": "application/json",
  });
  if (config.adminSecret) {
    headers.set("x-hasura-admin-secret", config.adminSecret);
  }

  let upstream: Response;
  try {
    upstream = await fetch(config.upstreamUrl, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NextResponse.json(
      { error: "Local Hasura upstream unavailable" },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
