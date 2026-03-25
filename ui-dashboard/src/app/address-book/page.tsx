import { getAuthSession } from "@/auth";
import AddressBookClient from "./AddressBookClient";

/**
 * Server component: resolves auth session, then renders the client page.
 * Middleware already redirects unauthenticated users away from /address-book,
 * so canEdit here mirrors the authenticated state for the in-page controls.
 */
export default async function AddressBookPage() {
  const session = await getAuthSession();
  return <AddressBookClient canEdit={!!session} />;
}
