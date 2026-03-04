import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { NetworkProvider } from "@/components/network-provider";
import { NetworkSelector } from "@/components/network-selector";
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
            <nav
              className="border-b border-slate-800 px-6 py-3 flex items-center gap-4"
              aria-label="Main navigation"
            >
              <Link
                href="/"
                className="text-lg font-bold text-white hover:text-indigo-400 transition-colors"
              >
                Mento v3 Monitor
              </Link>
              <NetworkSelector />
            </nav>
            <div className="mx-auto max-w-7xl px-6 py-6">{children}</div>
          </NetworkProvider>
        </Suspense>
      </body>
    </html>
  );
}
