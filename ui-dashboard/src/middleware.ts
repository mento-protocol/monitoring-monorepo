import { auth } from "@/auth";

export default auth((req) => {
  const isAuthenticated = !!req.auth;
  const path = req.nextUrl.pathname;

  if (!isAuthenticated && path.startsWith("/address-book")) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", path);
    return Response.redirect(signInUrl);
  }

  const isApiWrite =
    path.startsWith("/api/address-labels/") ||
    (path === "/api/address-labels" && req.method !== "GET");
  if (!isAuthenticated && isApiWrite) {
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
