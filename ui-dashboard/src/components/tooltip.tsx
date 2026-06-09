"use client";

import {
  cloneElement,
  isValidElement,
  useState,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

type TooltipAlign = "left" | "center" | "right";

const alignClass: Record<TooltipAlign, string> = {
  left: "left-0",
  center: "left-1/2 -translate-x-1/2",
  right: "right-0",
};

export function Tooltip({
  content,
  children,
  label,
  asChild = false,
  align = "center",
  className = "",
  tooltipClassName = "",
}: {
  content: ReactNode;
  children?: ReactNode;
  label?: string;
  asChild?: boolean;
  align?: TooltipAlign;
  className?: string;
  tooltipClassName?: string;
}) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  const defaultLabel =
    label ??
    (children == null && typeof content === "string" ? content : undefined);
  const trigger = asChild
    ? tooltipTriggerAsChild(children, tooltipId, label)
    : defaultTooltipTrigger(children, tooltipId, defaultLabel);

  return (
    <span
      className={["group relative inline-flex", className].join(" ")}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={() => setVisible(true)}
      onBlurCapture={() => setVisible(false)}
    >
      {trigger}
      <span
        id={tooltipId}
        role="tooltip"
        aria-hidden={!visible}
        className={[
          "pointer-events-none absolute top-full z-30 mt-1 w-72 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
          visible ? "opacity-100" : "",
          alignClass[align],
          tooltipClassName,
        ].join(" ")}
      >
        <span className="block whitespace-pre-line rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-left text-xs font-normal leading-relaxed text-slate-200 shadow-lg">
          {content}
        </span>
      </span>
    </span>
  );
}

function defaultTooltipTrigger(
  children: ReactNode,
  tooltipId: string,
  label: string | undefined,
) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={tooltipId}
      className="inline-flex cursor-help rounded border-0 bg-transparent p-0 text-inherit focus:outline-none focus:ring-1 focus:ring-indigo-500"
    >
      {children ?? (
        <span className="text-xs text-slate-500" aria-hidden="true">
          ⓘ
        </span>
      )}
    </button>
  );
}

type TooltipChildProps = {
  className?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
};

function tooltipTriggerAsChild(
  children: ReactNode,
  tooltipId: string,
  label: string | undefined,
) {
  if (!isValidElement<TooltipChildProps>(children)) {
    return defaultTooltipTrigger(children, tooltipId, label);
  }

  const child = children as ReactElement<TooltipChildProps>;
  const describedBy = child.props["aria-describedby"]
    ? `${child.props["aria-describedby"]} ${tooltipId}`
    : tooltipId;
  const nextProps: TooltipChildProps = {
    "aria-describedby": describedBy,
    className: [child.props.className, "cursor-help"].filter(Boolean).join(" "),
  };
  const nextLabel = child.props["aria-label"] ?? label;
  if (nextLabel !== undefined) nextProps["aria-label"] = nextLabel;

  return cloneElement(child, nextProps);
}
