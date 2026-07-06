import type { ComponentPropsWithoutRef, ReactNode } from "react";

export function Table({
  children,
  "aria-label": ariaLabel,
  scrollClassName,
}: {
  children: ReactNode;
  "aria-label"?: string;
  /**
   * Extra classes for the scroll wrapper. Use to opt a specific table into
   * `overflow-x` overrides — e.g. `xl:overflow-x-clip` to suppress the phantom
   * horizontal scrollbar that hover-tooltip popovers add at widths where the
   * table already fits, while keeping `overflow-x-auto` scrolling on narrow
   * viewports where the table genuinely overflows.
   *
   * Note: this is appended, not merged (no `tailwind-merge` here). It reliably
   * overrides the base `overflow-x-auto` only via a responsive prefix
   * (`xl:overflow-x-clip` wins at its breakpoint by media-query order). A
   * non-responsive `overflow-x-*` here would leave the winner to cascade order.
   */
  scrollClassName?: string;
}) {
  return (
    <div
      className={[
        "overflow-x-auto rounded-lg border border-slate-800",
        // Persistently-visible thin horizontal scrollbar so the scroll
        // affordance is signalled at rest — mobile Safari/Chrome hide the
        // native scrollbar until touched, which makes an off-screen column
        // (e.g. a wide swap amount) read as a silent clip rather than
        // scrollable content.
        "[&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-slate-900 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-600 [scrollbar-width:thin] [scrollbar-color:rgb(71_85_105)_rgb(15_23_42)]",
        scrollClassName,
      ]
        .filter(Boolean)
        .join(" ")}
    >
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
    // Numeric cells never wrap — an amount+symbol pair stays one intact
    // unit (a squeezed column scrolls the whole table rather than breaking
    // "22,900 cUSD" mid-value). tabular-nums keeps digit columns aligned.
    mono && "font-mono whitespace-nowrap tabular-nums",
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
