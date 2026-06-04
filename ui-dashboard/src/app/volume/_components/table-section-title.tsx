"use client";

import type { ReactNode } from "react";
import { InfoPopover } from "@/components/info-popover";

export function TableSectionTitle({
  children,
  info,
  label,
  className = "mb-3",
}: {
  children: ReactNode;
  info: string;
  label: string;
  className?: string;
}) {
  return (
    <h2
      className={`flex w-fit items-center gap-1.5 text-sm font-medium text-slate-300 ${className}`}
    >
      <span>{children}</span>
      <InfoPopover label={label} content={info} />
    </h2>
  );
}
