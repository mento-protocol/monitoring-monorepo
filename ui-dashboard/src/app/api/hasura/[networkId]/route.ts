import { NextRequest, NextResponse } from "next/server";

type LocalNetworkId =
  | "devnet"
  | "celo-sepolia-local"
  | "celo-mainnet-local";

type LocalHasuraConfig = {
  upstreamUrl: string;
  adminSecret: string;
};

function resolveLocalHasuraConfig(
  networkId: string,
): LocalHasuraConfig | null {
  switch (networkId as LocalNetworkId) {
    case "devnet":
      return {
        upstreamUrl:
          process.env.HASURA_UPSTREAM_URL_DEVNET ??
          "http://localhost:8080/v1/graphql",
        adminSecret: process.env.HASURA_SECRET_DEVNET?.trim() ?? "",
      };
    case "celo-sepolia-local":
      return {
        upstreamUrl:
          process.env.HASURA_UPSTREAM_URL_CELO_SEPOLIA_LOCAL ??
          "http://localhost:8080/v1/graphql",
        adminSecret:
          process.env.HASURA_SECRET_CELO_SEPOLIA_LOCAL?.trim() ?? "",
      };
    case "celo-mainnet-local":
      return {
        upstreamUrl:
          process.env.HASURA_UPSTREAM_URL_CELO_MAINNET_LOCAL ??
          "http://localhost:8080/v1/graphql",
        adminSecret:
          process.env.HASURA_SECRET_CELO_MAINNET_LOCAL?.trim() ?? "",
      };
    default:
      return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ networkId: string }> },
): Promise<Response> {
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

  const upstream = await fetch(config.upstreamUrl, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
  });

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
