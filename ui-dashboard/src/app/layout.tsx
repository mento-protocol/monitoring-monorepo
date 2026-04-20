import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { getAuthSession } from "@/auth";
import { NetworkProvider } from "@/components/network-provider";
import { AddressLabelsProvider } from "@/components/address-labels-provider";
import { NavLinks } from "@/components/nav-links";
import { AuthStatus } from "@/components/auth-status";
import { SwrProvider } from "@/components/swr-provider";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mento Analytics",
  description: "Cross-chain analytics dashboard for Mento protocol",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getAuthSession();

  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
      >
        <SessionProvider session={session}>
          <SwrProvider>
            <Suspense>
              <NetworkProvider>
                <AddressLabelsProvider>
                  <nav
                    className="border-b border-slate-800 px-3 sm:px-6 py-2 sm:py-3 flex items-center gap-2 sm:gap-4 flex-wrap"
                    aria-label="Main navigation"
                  >
                    <NavLinks />
                    <AuthStatus />
                  </nav>
                  <div className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6">
                    {children}
                  </div>
                </AddressLabelsProvider>
              </NetworkProvider>
            </Suspense>
          </SwrProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
