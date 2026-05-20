export const ADDRESS_LABELS_SWR_KEY = "address-labels:all";

export function isAddressLabelsSWRKey(key: unknown): boolean {
  return (
    key === ADDRESS_LABELS_SWR_KEY ||
    (Array.isArray(key) && key[0] === "address-labels")
  );
}
