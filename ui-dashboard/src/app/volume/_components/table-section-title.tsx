"use client";

import type { ReactNode } from "react";
import { Tooltip } from "@/components/tooltip";

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
      <Tooltip label={label} content={info} />
    </h2>
  );
}
