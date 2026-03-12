import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { NetworkProvider } from "@/components/network-provider";
import { AddressLabelsProvider } from "@/components/address-labels-provider";
import { NetworkSelector } from "@/components/network-selector";
import { NavLinks } from "@/components/nav-links";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mento v3 Monitor",
  description: "Monitoring dashboard for Mento v3 protocol",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
      >
        <Suspense>
          <NetworkProvider>
            <AddressLabelsProvider>
              <nav
                className="border-b border-slate-800 px-3 sm:px-6 py-2 sm:py-3 flex items-center gap-2 sm:gap-4 flex-wrap"
                aria-label="Main navigation"
              >
                <NavLinks />
                <NetworkSelector />
              </nav>
              <div className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6">
                {children}
              </div>
            </AddressLabelsProvider>
          </NetworkProvider>
        </Suspense>
      </body>
    </html>
  );
}
