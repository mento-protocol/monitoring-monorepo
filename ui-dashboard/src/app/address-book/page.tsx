import { getAuthSession } from "@/auth";
import AddressBookClient from "./AddressBookClient";

/**
 * Server component: resolves auth session, then renders the client page.
 * Write controls (Add/Edit/Delete/Import/Export) are hidden for unauthenticated users.
 */
export default async function AddressBookPage() {
  const session = await getAuthSession();
  return <AddressBookClient canEdit={!!session} />;
}
