import React from "react";

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return (
    <tr className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
      {children}
    </tr>
  );
}

export function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 font-medium text-slate-400 ${align === "right" ? "text-right" : "text-left"}`}
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
}: {
  children: React.ReactNode;
  mono?: boolean;
  small?: boolean;
  muted?: boolean;
  align?: "left" | "right";
  title?: string;
}) {
  const cls = [
    "px-4 py-2",
    mono && "font-mono",
    small && "text-xs",
    muted ? "text-slate-400" : "text-slate-300",
    align === "right" && "text-right",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <td className={cls} title={title}>
      {children}
    </td>
  );
}
