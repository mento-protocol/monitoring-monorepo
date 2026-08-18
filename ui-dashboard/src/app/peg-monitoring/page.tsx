import type { Metadata } from "next";
import { PegMonitoringPageClient } from "./peg-monitoring-page-client";

const title = "Peg Monitoring | Mento Monitoring";
const description =
  "Current peg measurements, decision status, and supporting evidence for Mento monitoring.";

// `openGraph` and `twitter` are spelled out rather than left to inherit: a
// page-level `title`/`description` does not override the root layout's
// `openGraph` block, so without these the peg card would unfurl under
// "Mento Analytics". Same shape as the bridge-flows and pool cards.
export const metadata: Metadata = {
  title,
  description,
  openGraph: { title, description, type: "website" },
  twitter: { card: "summary_large_image", title, description },
};
export default function PegMonitoringPage(): React.JSX.Element {
  return <PegMonitoringPageClient />;
}
