import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { getAuthSession } from "@/auth";
import { NetworkProvider } from "@/components/network-provider";
import { AddressLabelsProvider } from "@/components/address-labels-provider";
import { NavLinks } from "@/components/nav-links";
import { AuthStatus } from "@/components/auth-status";
import { fetchHomepageOgData } from "@/lib/homepage-og";
import { formatUSD } from "@/lib/format";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// 60s — operational stats (TVL, health, attention count) matter fresh,
// not cached for an hour. Matches the helper + image route TTLs below.
export const revalidate = 60;

const FALLBACK_TITLE = "Mento Analytics";
const FALLBACK_DESCRIPTION =
  "Cross-chain analytics dashboard for Mento protocol";

function buildDescription(
  data: NonNullable<Awaited<ReturnType<typeof fetchHomepageOgData>>>,
): string {
  const parts: string[] = [];
  if (data.totalTvlUsd != null && data.totalTvlUsd > 0) {
    parts.push(`TVL ${formatUSD(data.totalTvlUsd)}`);
  }
  if (data.totalVolume7dUsd != null) {
    parts.push(`7d volume ${formatUSD(data.totalVolume7dUsd)}`);
  }
  parts.push(`${data.poolCount} pools on ${data.chains.join(" + ")}`);
  const { WARN = 0, CRITICAL = 0 } = data.healthBuckets;
  const attention = WARN + CRITICAL;
  if (attention > 0) parts.push(`${attention} need attention`);
  return parts.join(" · ");
}

export async function generateMetadata(): Promise<Metadata> {
  const data = await fetchHomepageOgData();
  if (!data) {
    return {
      title: FALLBACK_TITLE,
      description: FALLBACK_DESCRIPTION,
      openGraph: {
        title: FALLBACK_TITLE,
        description: FALLBACK_DESCRIPTION,
        type: "website",
      },
      twitter: {
        card: "summary_large_image",
        title: FALLBACK_TITLE,
        description: FALLBACK_DESCRIPTION,
      },
    };
  }
  const description = buildDescription(data);
  return {
    title: FALLBACK_TITLE,
    description,
    openGraph: {
      title: FALLBACK_TITLE,
      description,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: FALLBACK_TITLE,
      description,
    },
  };
}

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
        </SessionProvider>
      </body>
    </html>
  );
}
