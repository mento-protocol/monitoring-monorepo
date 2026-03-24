import { auth } from "@/auth";

export default auth((req) => {
  const isAuthenticated = !!req.auth;
  const path = req.nextUrl.pathname;

  if (!isAuthenticated && path.startsWith("/address-book")) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", path);
    return Response.redirect(signInUrl);
  }

  // Protect write operations on /api/address-labels (non-GET) and all
  // sub-paths except /backup (which authenticates via CRON_SECRET).
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
