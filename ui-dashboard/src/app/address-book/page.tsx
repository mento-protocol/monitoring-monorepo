import type { Metadata } from "next";
import AddressBookClient from "./AddressBookClient";

export const metadata: Metadata = {
  title: "Address Book — Mento Analytics",
  description:
    "Mento address book — labels and forensic reports for tracked counterparties.",
  robots: { index: false, follow: false },
};

/**
 * /address-book is middleware-protected, so by the time this page renders the
 * user is authenticated and edit controls can be enabled unconditionally.
 */
export default function AddressBookPage() {
  return <AddressBookClient canEdit />;
}
