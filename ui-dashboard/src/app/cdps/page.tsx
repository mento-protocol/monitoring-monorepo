import type { Metadata } from "next";
import { CdpsPageClient } from "./_components/cdps-page-client";

export const metadata: Metadata = {
  title: "CDPs — Mento Analytics",
  description: "System health and borrower activity for Mento CDP markets.",
};

export default function CdpsPage() {
  return <CdpsPageClient />;
}
