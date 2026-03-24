import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_DOMAIN = "@mentolabs.xyz";

export const { handlers, auth, signIn, signOut } = NextAuth({
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
        return profile?.email?.toLowerCase().endsWith(ALLOWED_DOMAIN) ?? false;
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
