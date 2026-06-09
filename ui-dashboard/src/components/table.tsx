import type { ComponentPropsWithoutRef, ReactNode } from "react";

export function Table({
  children,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full text-sm" aria-label={ariaLabel}>
        {children}
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
      {children}
    </tr>
  );
}

export function Th({
  children,
  align = "left",
  className,
  ...props
}: {
  children: ReactNode;
  align?: "left" | "right";
} & ComponentPropsWithoutRef<"th">) {
  return (
    <th
      scope="col"
      className={[
        "px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  mono,
  small,
  muted,
  align = "left",
  title,
  className,
}: {
  children: ReactNode;
  mono?: boolean;
  small?: boolean;
  muted?: boolean;
  align?: "left" | "right";
  title?: string;
  className?: string;
}) {
  const cls = [
    "px-2 sm:px-4 py-1.5 sm:py-2",
    mono && "font-mono",
    small ? "text-[10px] sm:text-xs" : "text-xs sm:text-sm",
    muted ? "text-slate-400" : "text-slate-300",
    align === "right" && "text-right",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <td className={cls} title={title}>
      {children}
    </td>
  );
}
