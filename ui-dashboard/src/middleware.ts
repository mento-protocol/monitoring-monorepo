import { auth } from "@/auth";

const authConfigured = !!(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);

// On Vercel preview deployments, skip app-level auth entirely.
// Preview URLs are already gated behind Vercel Deployment Protection (team SSO),
// so only authorized team members can reach the preview in the first place.
// This avoids the cross-domain cookie issue where OAuth state/PKCE cookies set
// on the preview domain are inaccessible when the callback lands on the prod domain.
const isPreview = process.env.VERCEL_ENV === "preview";

export default auth((req) => {
  if (!authConfigured || isPreview) return;

  const isAuthenticated = !!req.auth;
  const path = req.nextUrl.pathname;

  if (!isAuthenticated && path.startsWith("/address-book")) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", `${path}${req.nextUrl.search}`);
    return Response.redirect(signInUrl);
  }

  // /backup is excluded — it authenticates via CRON_SECRET in-route.
  const isProtectedApi =
    (path.startsWith("/api/address-labels/") &&
      !path.startsWith("/api/address-labels/backup")) ||
    (path === "/api/address-labels" && req.method !== "GET");
  if (!isAuthenticated && isProtectedApi) {
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
