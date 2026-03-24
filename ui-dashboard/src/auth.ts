import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_DOMAIN = "@mentolabs.xyz";

const nextAuth = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],

  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },

  pages: {
    signIn: "/sign-in",
  },

  callbacks: {
    signIn({ account, profile }) {
      if (account?.provider === "google") {
        return profile?.email?.endsWith("@mentolabs.xyz") ?? false;
      }
      return false;
    },
    jwt({ token, profile }) {
      if (profile?.email) {
        token.email = profile.email;
      }
      return token;
    },
    session({ session, token }) {
      if (token.email && session.user) {
        session.user.email = token.email as string;
      }
      return session;
    },
  },
});

export const { handlers, auth, signIn, signOut } = nextAuth;

/**
 * Returns the session if the user is authenticated with an allowed domain,
 * or null otherwise. Use this in route handlers for auth gating.
 */
export async function getAuthSession() {
  const session = await auth();
  return session?.user?.email?.endsWith(ALLOWED_DOMAIN) ? session : null;
}
