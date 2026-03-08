"use client";

import { AddressLink } from "@/components/address-link";

export function SenderCell({
  address,
  className,
}: {
  address: string;
  className?: string;
}) {
  return (
    <td
      className={`px-2 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs ${className ?? ""}`}
    >
      <AddressLink address={address} />
    </td>
  );
}
