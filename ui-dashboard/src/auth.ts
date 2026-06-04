import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import type { JWT } from "next-auth/jwt";
import * as Sentry from "@sentry/nextjs";

// Exported so middleware.ts can enforce the same suffix — keeping two
// independent literals would let the edge and the sign-in callback drift.
export const ALLOWED_DOMAIN = "@mentolabs.xyz";

// Google's OAuth 2.0 token endpoint, from
// https://accounts.google.com/.well-known/openid-configuration
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Probe Google with the stored refresh token to confirm the account is still
// active, rolling `expires_at` forward. Mutates and returns the token. Three
// outcomes:
//   - success         → account live; bump expires_at (+ rotated refresh token
//                       if Google returned one) and clear any prior error.
//   - `invalid_grant` → refresh token revoked: account suspended/deleted or
//                       consent withdrawn → mark errored so the session is
//                       rejected downstream. This is the offboarding cutoff.
//   - anything else   → transient (5xx / rate-limit) or OUR misconfig
//                       (`invalid_client`, a bad secret): do NOT evict the user
//                       — back off and re-probe in 5 min, so a Google blip or a
//                       deploy with a broken secret can't log out everyone.
async function refreshGoogleAccessToken(token: JWT): Promise<JWT> {
  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_GOOGLE_ID ?? "",
        client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: token.refresh_token ?? "",
      }),
    });

    const data = (await response.json()) as {
      expires_in?: number;
      refresh_token?: string;
      error?: string;
    };

    if (!response.ok) {
      if (data.error === "invalid_grant") {
        // The only signal we treat as a definitive "cut them off".
        token.error = "RefreshTokenError";
        delete token.refresh_token;
        return token;
      }
      throw new Error(
        `Google token refresh failed: ${response.status} ${data.error ?? ""}`,
      );
    }

    token.expires_at =
      Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
    if (data.refresh_token) token.refresh_token = data.refresh_token;
    delete token.error;
    return token;
  } catch (error) {
    // Transient/network/misconfig — keep the session alive, retry in 5 min.
    Sentry.captureException(error, { tags: { source: "nextauth-refresh" } });
    token.expires_at = Math.floor(Date.now() / 1000) + 5 * 60;
    return token;
  }
}

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
      // Request offline access so Google issues a refresh token. We never call
      // a Google API with it — it is used purely as a periodic liveness probe
      // in the `jwt` callback (see `refreshGoogleAccessToken`) to confirm the
      // account is still active. `prompt: "consent"` is required for Google to
      // reliably return a refresh token on every sign-in (without it, Google
      // only returns one on the user's first-ever consent).
      authorization: {
        params: { access_type: "offline", prompt: "consent" },
      },
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

  // Sliding 30-day session for UX (active use re-mints the token, so regular
  // users stay signed in; only fully-idle sessions age out after 30 days), with
  // offboarding handled by the `jwt` callback re-validating against Google.
  // The 30-day window is just the fallback for a lost/offline device — the real
  // cutoff is the ~hourly Google refresh-token probe: when an account is
  // suspended or deleted, Google revokes its refresh token, the probe fails with
  // `invalid_grant`, and the session is marked errored (see the jwt callback and
  // `getAuthSession`). Deploys do NOT log users out: the JWT lives in the cookie
  // and is verified with the stable AUTH_SECRET, which a new deployment doesn't
  // change.
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
    async jwt({ token, account, profile }) {
      // First-time sign-in: persist identity plus the Google refresh token and
      // its expiry. We intentionally do NOT store the access token — it's never
      // used to call a Google API, and keeping it out of the cookie avoids
      // bloating the JWT (which would force cookie chunking).
      if (account) {
        if (profile?.email) token.email = profile.email;
        if (account.refresh_token) {
          token.refresh_token = account.refresh_token;
          token.expires_at =
            account.expires_at ?? Math.floor(Date.now() / 1000) + 3600;
          delete token.error;
        } else {
          // With access_type=offline + prompt=consent Google should always
          // return a refresh token; if it somehow doesn't, force a re-auth
          // rather than mint a session we can't later re-validate.
          token.error = "RefreshTokenError";
        }
        return token;
      }

      // No probe data — either a session minted before this shipped, or a
      // sign-in that returned no refresh token. Force one re-auth to obtain
      // one: active employees re-auth silently, offboarded ones fail at signIn.
      if (typeof token.expires_at !== "number" || !token.refresh_token) {
        token.error = "RefreshTokenError";
        return token;
      }

      // Access token still fresh — no need to probe Google yet.
      if (Date.now() < token.expires_at * 1000) {
        return token;
      }

      // Access token expired (~hourly) — probe Google to confirm the account
      // is still active before extending the session.
      return refreshGoogleAccessToken(token);
    },
    session({ session, token }) {
      if (typeof token.email === "string" && session.user) {
        session.user.email = token.email;
      }
      if (token.error) session.error = token.error;
      return session;
    },
  },
});

export async function getAuthSession() {
  const session = await auth();
  // A failed Google refresh probe (offboarded / revoked account) invalidates
  // the session even though the JWT itself is still cryptographically valid.
  if (session?.error === "RefreshTokenError") return null;
  return session?.user?.email?.toLowerCase().endsWith(ALLOWED_DOMAIN)
    ? session
    : null;
}

// Module augmentation is co-located here (rather than in auth.d.ts) so it
// reliably merges with next-auth's types: a sibling `auth.d.ts` is treated as
// the declaration file *for the @/auth module*, and `declare module` blocks
// inside it don't dependably augment `next-auth` / `next-auth/jwt`.
declare module "next-auth" {
  interface Session {
    error?: "RefreshTokenError";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    // Unix seconds when the Google access token expires — drives when the jwt
    // callback re-probes Google.
    expires_at?: number;
    // Google refresh token; used only as a liveness probe, never to call an API.
    refresh_token?: string;
    error?: "RefreshTokenError";
  }
}
