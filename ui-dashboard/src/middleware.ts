import { ALLOWED_DOMAIN, auth } from "@/auth";

const authConfigured = !!(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);

export default auth((req) => {
  if (!authConfigured) return;

  // Enforce the domain allowlist at the edge. The sign-in callback already
  // verifies `hd + email_verified + email`, but a forged JWT (e.g. if
  // AUTH_SECRET ever leaked) with the right shape but wrong email suffix
  // would otherwise sail through middleware on a bare `!!req.auth` check.
  const email = req.auth?.user?.email?.toLowerCase();
  const isAuthorized = !!email?.endsWith(ALLOWED_DOMAIN);
  const path = req.nextUrl.pathname;

  if (!isAuthorized && path.startsWith("/address-book")) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", `${path}${req.nextUrl.search}`);
    return Response.redirect(signInUrl);
  }

  // /backup and /restore authenticate via CRON_SECRET (or session) in
  // the route handler itself, so middleware exempts them — otherwise the
  // bearer-token path would 401 here before reaching the route auth guard.
  // GET /api/address-labels is no longer a public endpoint (see the CSP
  // PR) — middleware enforces auth on every method now.
  const isProtectedApi =
    path.startsWith("/api/address-labels/") &&
    !path.startsWith("/api/address-labels/backup") &&
    !path.startsWith("/api/address-labels/restore");
  const isLabelsRoot = path === "/api/address-labels";
  if (!isAuthorized && (isProtectedApi || isLabelsRoot)) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
});

export const config = {
  matcher: [
    "/address-book/:path*",
    "/api/address-labels",
    "/api/address-labels/:path*",
  ],
};
