import AddressBookClient from "./AddressBookClient";

/**
 * /address-book is middleware-protected, so by the time this page renders the
 * user is authenticated and edit controls can be enabled unconditionally.
 */
export default function AddressBookPage() {
  return <AddressBookClient canEdit />;
}
