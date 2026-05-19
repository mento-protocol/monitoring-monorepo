import { type CdpHealth, healthBadgeClasses } from "../_lib/health";

export function CdpHealthBadge({ health }: { health: CdpHealth }) {
  const title = health.reasons.join(" · ") || health.label;
  return (
    <span
      className={`text-xs rounded px-2 py-1 font-medium ${healthBadgeClasses(health.state)}`}
      title={title}
      aria-label={`Health: ${health.label}. ${title}`}
    >
      {health.label}
    </span>
  );
}
