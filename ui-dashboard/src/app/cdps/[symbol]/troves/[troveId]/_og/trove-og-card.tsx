import type { TroveOgData, TroveOgTone } from "../_lib/trove-og-data";

const BG = "#0f172a";
const PANEL = "#111827";
const TILE = "#162033";
const BORDER = "#334155";
const TEXT = "#f8fafc";
const MUTED = "#94a3b8";
const DIM = "#64748b";
const INDIGO = "#818cf8";

const TONE_COLOR: Record<TroveOgTone, string> = {
  healthy: "#6ee7b7",
  warning: "#fbbf24",
  critical: "#fb7185",
  info: "#a5b4fc",
  neutral: "#94a3b8",
};

const TONE_BG: Record<TroveOgTone, string> = {
  healthy: "rgba(52, 211, 153, 0.10)",
  warning: "rgba(251, 191, 36, 0.10)",
  critical: "rgba(251, 113, 133, 0.10)",
  info: "rgba(129, 140, 248, 0.12)",
  neutral: "rgba(148, 163, 184, 0.08)",
};

export type TroveOgIdentity = { symbol: string; troveId: string };

export function shortTroveId(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function GridBackdrop() {
  return (
    <div
      style={{
        display: "flex",
        position: "absolute",
        inset: 0,
        opacity: 0.16,
      }}
    >
      {Array.from({ length: 10 }, (_, index) => (
        <div
          key={`v-${index}`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: index * 120,
            width: 1,
            background: BORDER,
          }}
        />
      ))}
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={`h-${index}`}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: index * 126,
            height: 1,
            background: BORDER,
          }}
        />
      ))}
    </div>
  );
}

function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div
        style={{
          display: "flex",
          width: 38,
          height: 38,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          background: INDIGO,
          color: "#ffffff",
          fontSize: 23,
          fontWeight: 800,
        }}
      >
        M
      </div>
      <span style={{ fontSize: 25, fontWeight: 700, color: TEXT }}>Mento</span>
      <span style={{ fontSize: 25, color: MUTED }}>Analytics</span>
    </div>
  );
}

function IdentityPill({ identity }: { identity: TroveOgIdentity }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 10,
        padding: "10px 15px",
        borderRadius: 999,
        border: `1px solid ${BORDER}`,
        background: "rgba(30, 41, 59, 0.74)",
        color: MUTED,
        fontSize: 19,
      }}
    >
      <span style={{ color: "#c7d2fe", fontWeight: 700 }}>
        {identity.symbol.toUpperCase()}
      </span>
      <span style={{ color: DIM }}>·</span>
      <span style={{ fontFamily: '"Geist", monospace' }}>
        Trove {shortTroveId(identity.troveId)}
      </span>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: TroveOgTone;
}) {
  const color = TONE_COLOR[tone];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        height: 132,
        padding: "20px 18px",
        borderRadius: 14,
        border: `1px solid ${BORDER}`,
        background: TILE,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            color: MUTED,
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: 1.5,
          }}
        >
          {label}
        </span>
        <div
          style={{
            display: "flex",
            width: 10,
            height: 10,
            borderRadius: 10,
            background: color,
            boxShadow: `0 0 18px ${color}`,
          }}
        />
      </div>
      <span
        style={{
          display: "flex",
          flex: 1,
          alignItems: "flex-end",
          color,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: -0.5,
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function LifecycleRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div style={{ display: "flex", minHeight: 66 }}>
      <div
        style={{
          display: "flex",
          width: 34,
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 14,
            height: 14,
            marginTop: 5,
            borderRadius: 14,
            border: `3px solid ${INDIGO}`,
            background: PANEL,
          }}
        />
        {!last && (
          <div
            style={{
              display: "flex",
              width: 2,
              flex: 1,
              marginTop: 5,
              background: BORDER,
            }}
          />
        )}
      </div>
      <div
        style={{
          display: "flex",
          flex: 1,
          justifyContent: "space-between",
          alignItems: "flex-start",
          paddingLeft: 10,
          paddingRight: 4,
        }}
      >
        <span
          style={{
            color: MUTED,
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: 0.7,
          }}
        >
          {label}
        </span>
        <span style={{ color: TEXT, fontSize: 18, fontWeight: 600 }}>
          {value}
        </span>
      </div>
    </div>
  );
}

function SnapshotPanelHeader({
  statusLabel,
  statusTone,
}: {
  statusLabel: string;
  statusTone: TroveOgTone;
}) {
  const statusColor = TONE_COLOR[statusTone];
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 20,
      }}
    >
      <span
        style={{
          color: MUTED,
          fontSize: 17,
          fontWeight: 600,
          letterSpacing: 1.7,
        }}
      >
        INDEXED POSITION SNAPSHOT
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "8px 14px",
          borderRadius: 999,
          background: TONE_BG[statusTone],
          border: `1px solid ${statusColor}66`,
        }}
      >
        <div
          style={{
            display: "flex",
            width: 9,
            height: 9,
            borderRadius: 9,
            background: statusColor,
          }}
        />
        <span style={{ color: statusColor, fontSize: 17, fontWeight: 700 }}>
          {statusLabel}
        </span>
      </div>
    </div>
  );
}

function SnapshotStats({ data }: { data: TroveOgData | null }) {
  const statusTone = data?.statusTone ?? "neutral";
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <StatTile
        label="STATUS"
        value={data?.statusLabel ?? "—"}
        tone={statusTone}
      />
      <StatTile label="COLLATERAL" value={data?.collateral ?? "—"} />
      <StatTile label="DEBT" value={data?.debt ?? "—"} />
      <StatTile
        label="ICR"
        value={data?.icr ?? "—"}
        tone={data?.icrTone ?? "neutral"}
      />
    </div>
  );
}

function LifecyclePanel({ data }: { data: TroveOgData | null }) {
  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        flexDirection: "column",
        marginTop: 22,
        padding: "19px 22px 13px",
        borderRadius: 14,
        border: `1px solid ${BORDER}`,
        background: "rgba(15, 23, 42, 0.66)",
      }}
    >
      <span
        style={{
          marginBottom: 15,
          color: MUTED,
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: 1.5,
        }}
      >
        POSITION LIFECYCLE
      </span>
      {data === null ? (
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            color: MUTED,
            fontSize: 24,
          }}
        >
          The indexed snapshot is temporarily unavailable.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <LifecycleRow label="Opened" value={data.openedDate} />
          <LifecycleRow
            label={data.lastEventLabel}
            value={data.lastEventDate}
            last
          />
        </div>
      )}
    </div>
  );
}

function SnapshotPanel({ data }: { data: TroveOgData | null }) {
  const statusTone = data?.statusTone ?? "neutral";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        height: "100%",
        padding: 24,
        borderRadius: 20,
        border: "2px solid rgba(129, 140, 248, 0.38)",
        background: "rgba(15, 23, 42, 0.94)",
        boxShadow: "0 24px 80px rgba(49, 46, 129, 0.32)",
      }}
    >
      <SnapshotPanelHeader
        statusLabel={data?.statusLabel ?? "Data unavailable"}
        statusTone={statusTone}
      />
      <SnapshotStats data={data} />
      <LifecyclePanel data={data} />
    </div>
  );
}

export function TroveOgCard({
  data,
  identity,
}: {
  data: TroveOgData | null;
  identity: TroveOgIdentity;
}) {
  const displayedIdentity = data ?? identity;
  return (
    // react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        padding: "46px 48px",
        background: `linear-gradient(135deg, ${BG} 0%, #0b1020 100%)`,
        color: TEXT,
        fontFamily: '"Geist", "Inter", "Helvetica", sans-serif',
      }}
    >
      <GridBackdrop />
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: 270,
          top: 172,
          width: 330,
          height: 330,
          borderRadius: 330,
          background: "rgba(79, 70, 229, 0.15)",
        }}
      />

      <div
        style={{
          display: "flex",
          position: "relative",
          width: 360,
          flexShrink: 0,
          flexDirection: "column",
          justifyContent: "space-between",
          paddingRight: 34,
        }}
      >
        <Brand />
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              color: TEXT,
              fontSize: 76,
              lineHeight: 0.96,
              fontWeight: 800,
              letterSpacing: -3,
            }}
          >
            <span>Trove</span>
            <span>History</span>
          </div>
          <IdentityPill identity={displayedIdentity} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ color: MUTED, fontSize: 17 }}>
            Actual values from indexed events
          </span>
          <span style={{ color: DIM, fontSize: 16 }}>monitoring.mento.org</span>
        </div>
      </div>

      <SnapshotPanel data={data} />
    </div>
  );
}
