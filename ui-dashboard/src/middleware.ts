import { NextResponse } from "next/server";
import { ALLOWED_DOMAIN, auth } from "@/auth";
import { buildCspWithNonce } from "@/lib/csp";

const authConfigured = !!(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);

function isAddressBookPath(path: string) {
  return (
    path === "/address-book" ||
    path.startsWith("/address-book/") ||
    path === "/entities" ||
    path.startsWith("/entities/")
  );
}

function isProtectedAddressLabelsApi(path: string) {
  // /backup and /restore authenticate via CRON_SECRET (or session) in
  // the route handler itself, so middleware exempts them — otherwise the
  // bearer-token path would 401 here before reaching the route auth guard.
  // GET /api/address-labels is no longer a public endpoint — middleware
  // enforces auth on every method now.
  return (
    path === "/api/address-labels" ||
    (path.startsWith("/api/address-labels/") &&
      !path.startsWith("/api/address-labels/backup") &&
      !path.startsWith("/api/address-labels/restore"))
  );
}

function authMisconfiguredResponse(csp: string, isApi: boolean) {
  if (isApi) {
    return new Response(
      JSON.stringify({ error: "Authentication unavailable" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "content-security-policy": csp,
        },
      },
    );
  }

  return new Response("Authentication unavailable", {
    status: 503,
    headers: {
      "content-security-policy": csp,
    },
  });
}

// Middleware runs on every non-static route (see `config.matcher` below).
// Two responsibilities:
//
// 1. Per-request nonce — a fresh 16-byte random nonce is generated for
//    every request and embedded in the `script-src` CSP directive. Next.js
//    App Router reads `content-security-policy` from the *request* headers
//    to apply the nonce to its own inline <script> injections (RSC payload,
//    hydration). We echo the CSP on the response so the browser enforces it.
//
// 2. Auth protection — /address-book and /api/address-labels require a
//    verified @mentolabs.xyz session. `auth(callback)` from NextAuth v5
//    attaches `.auth` (session) to the request before calling the callback.
export default auth((req) => {
  // 1. Nonce + CSP
  // Use Web Crypto + btoa (not Buffer) — Edge runtime lacks the Node.js Buffer global.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...bytes));
  const csp = buildCspWithNonce(nonce);

  // 2. Auth checks (protected paths only)
  const path = req.nextUrl.pathname;
  const isProtectedPage = isAddressBookPath(path);
  const isProtectedApi = isProtectedAddressLabelsApi(path);

  if (isProtectedPage || isProtectedApi) {
    if (!authConfigured) {
      return authMisconfiguredResponse(csp, isProtectedApi);
    }

    const email = req.auth?.user?.email?.toLowerCase();
    const isAuthorized = !!email?.endsWith(ALLOWED_DOMAIN);

    if (!isAuthorized && isProtectedPage) {
      const signInUrl = new URL("/sign-in", req.nextUrl.origin);
      signInUrl.searchParams.set("callbackUrl", `${path}${req.nextUrl.search}`);
      const redirectRes = NextResponse.redirect(signInUrl, 302);
      redirectRes.headers.set("content-security-policy", csp);
      return redirectRes;
    }

    if (!isAuthorized && isProtectedApi) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "content-security-policy": csp,
          },
        },
      );
    }
  }

  // 3. Continue to route handler
  // Forward the nonce-bearing CSP in request headers so Next.js App Router
  // can attach the nonce to its server-rendered inline <script> tags, and
  // set it in response headers so the browser enforces the policy.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
});

export const config = {
  matcher: [
    // Run on all routes except Next.js static build artifacts and images.
    // The Sentry tunnel (/monitoring) and API routes also pass through —
    // they receive the nonce CSP header, but only the address-labels paths
    // enforce auth above.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
