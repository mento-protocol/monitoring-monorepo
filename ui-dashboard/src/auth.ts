import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import * as Sentry from "@sentry/nextjs";

// Exported so middleware.ts can enforce the same suffix — keeping two
// independent literals would let the edge and the sign-in callback drift.
export const ALLOWED_DOMAIN = "@mentolabs.xyz";

export const { handlers, auth, signIn, signOut } = NextAuth({
  // On preview deployments NEXTAUTH_URL is set to the production URL so that
  // the Google OAuth callback always lands on the whitelisted prod domain.
  // AUTH_REDIRECT_PROXY_URL tells NextAuth to forward the session back to the
  // actual preview URL after a successful sign-in.
  // In production both env vars are unset and NextAuth resolves URLs normally.
  ...(process.env.AUTH_REDIRECT_PROXY_URL
    ? { redirectProxyUrl: process.env.AUTH_REDIRECT_PROXY_URL }
    : {}),

  providers: [
    Google({
      ...(process.env.AUTH_GOOGLE_ID
        ? { clientId: process.env.AUTH_GOOGLE_ID }
        : {}),
      ...(process.env.AUTH_GOOGLE_SECRET
        ? { clientSecret: process.env.AUTH_GOOGLE_SECRET }
        : {}),
      // On preview deployments PKCE cannot be used: the code verifier cookie is
      // set on the preview domain but the callback lands on prod (via the proxy)
      // — different domains, cookie never sent. Use state-only: JWE signed with
      // AUTH_SECRET (identical on prod and preview), verified server-side.
      // AUTH_REDIRECT_PROXY_URL is set on BOTH envs for the proxy handshake,
      // so we key off VERCEL_ENV instead to keep PKCE on direct prod logins.
      // See: https://authjs.dev/getting-started/deployment#securing-a-preview-deployment
      ...(process.env.VERCEL_ENV === "preview" ? { checks: ["state"] } : {}),
    }),
  ],

  // Sliding 30-day session. On an active request NextAuth re-mints the token
  // (at most once per `updateAge`), extending exp to now + maxAge — so anyone
  // using the dashboard regularly stays signed in indefinitely, and only fully
  // idle sessions age out after 30 days. Deploys do NOT log users out: the JWT
  // lives in the cookie and is verified with the stable AUTH_SECRET, which a
  // new deployment doesn't change.
  // Tradeoff: with stateless JWTs there is no server-side revocation, so an
  // offboarded user's un-expired cookie keeps working until it ages out —
  // disabling their Google account does not cut access early, since the JWT
  // self-validates and isn't re-checked against Google until expiry. If that
  // window becomes unacceptable, add a revocation check (e.g. an Upstash
  // deny-set read in the jwt callback) rather than shortening maxAge.
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },

  pages: {
    signIn: "/sign-in",
  },

  // Fire NextAuth internal errors (OAuth handshake failures, JWE verification
  // breaks, callback URL mismatches) to Sentry so sign-in regressions don't
  // need "users can't log in" bug reports to be noticed.
  logger: {
    error(error) {
      Sentry.captureException(error, { tags: { source: "nextauth" } });
    },
  },

  callbacks: {
    signIn({ account, profile }) {
      if (account?.provider !== "google") return false;
      // `hd` is Google's hosted-domain claim — set server-side based on the
      // authenticated Workspace tenant, not the self-declared email string.
      // A personal Gmail cannot produce `hd: "mentolabs.xyz"`, and a user on
      // a different Workspace with `mentolabs.xyz` as a secondary alias
      // carries that Workspace's `hd`, not ours.
      const p = profile as
        | { hd?: string; email_verified?: boolean }
        | undefined;
      if (p?.hd !== "mentolabs.xyz") return false;
      if (p?.email_verified !== true) return false;
      return profile?.email?.toLowerCase().endsWith(ALLOWED_DOMAIN) ?? false;
    },
    jwt({ token, profile }) {
      if (profile?.email) {
        token.email = profile.email;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.email === "string" && session.user) {
        session.user.email = token.email;
      }
      return session;
    },
  },
});

export async function getAuthSession() {
  const session = await auth();
  return session?.user?.email?.toLowerCase().endsWith(ALLOWED_DOMAIN)
    ? session
    : null;
}
