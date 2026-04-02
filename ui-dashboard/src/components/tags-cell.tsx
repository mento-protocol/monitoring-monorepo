"use client";

import { useAddressLabels } from "@/components/address-labels-provider";
import { TagPills } from "@/components/tag-pills";

export function TagsCell({
  address,
  className,
}: {
  address: string;
  className?: string;
}) {
  const { getTags } = useAddressLabels();
  const tags = getTags(address);

  return (
    <td
      className={`px-2 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs ${className ?? ""}`}
    >
      {tags.length > 0 && <TagPills tags={tags} />}
    </td>
  );
}
