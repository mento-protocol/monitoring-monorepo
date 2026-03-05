"use client";

import { AddressLink } from "@/components/address-link";

export function SenderCell({ address }: { address: string }) {
  return (
    <td className="px-4 py-2 text-xs">
      <AddressLink address={address} />
    </td>
  );
}
