import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import localFont from "next/font/local";
import { SessionProvider } from "next-auth/react";
import { getAuthSession } from "@/auth";
import { NetworkProvider } from "@/components/network-provider";
import { AddressLabelsProvider } from "@/components/address-labels-provider";
import { ResponsiveNav } from "@/components/responsive-nav";
import { DataFreshnessBanner } from "@/components/data-freshness-banner";
import { ResourceHints } from "@/components/resource-hints";
import { SessionErrorGuard } from "@/components/session-error-guard";
import { SwrProvider } from "@/components/swr-provider";
import { PlotlyIdlePreloader } from "@/components/plotly-idle-preloader";
import { Analytics } from "@vercel/analytics/next";
import { clientEnv } from "@/env";
import { serverEnv } from "@/server-env";
import { resolveMetadataBase } from "@/lib/site-metadata";
import "./globals.css";

// This is server-only; local `next start` needs analytics development mode.
const analyticsMode = serverEnv.VERCEL ? "auto" : "development";

const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  display: "swap",
});
const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  display: "swap",
});
const analyticsEnabled = !clientEnv.NEXT_PUBLIC_BROWSER_TEST_FIXTURES;

// Base metadata for every route. The homepage overrides via its own
// `generateMetadata` in `app/(home)/page.tsx` — keeping the dynamic fetch scoped
// there so non-homepage routes don't inherit the cross-chain I/O latency
// when the OG cache is cold.
export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const title = "Mento Analytics";
  const description = "Cross-chain analytics dashboard for Mento protocol";
  return {
    metadataBase: resolveMetadataBase(requestHeaders),
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export const viewport: Viewport = {
  colorScheme: "dark",
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
        <PlotlyIdlePreloader />
        <ResourceHints />
        <SessionProvider session={session}>
          <SessionErrorGuard />
          <SwrProvider>
            <Suspense>
              <NetworkProvider>
                <AddressLabelsProvider>
                  <nav
                    className="border-b border-slate-800 px-3 py-2 sm:px-6 sm:py-3"
                    aria-label="Main navigation"
                  >
                    <ResponsiveNav />
                  </nav>
                  <DataFreshnessBanner />
                  <div className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6">
                    {children}
                  </div>
                </AddressLabelsProvider>
              </NetworkProvider>
            </Suspense>
          </SwrProvider>
        </SessionProvider>
        {analyticsEnabled && <Analytics mode={analyticsMode} />}
      </body>
    </html>
  );
}
