import { AddressLink } from "@/components/address-link";
import { EmptyBox } from "@/components/feedback";
import { Table, Row, Th, Td } from "@/components/table";
import { relativeTime } from "@/lib/format";
import {
  CDP_STABILITY_POOL_DEPOSITORS_DETAIL_LIMIT,
  type CdpDepositor,
} from "../../_lib/types";
import { formatSignedWei, formatTokenAmount } from "../../_lib/format";

const compactDepositorCellClassName = "!px-2 whitespace-nowrap";
const compactDepositorHeaderClassName = "!px-2";

export function DepositorTable({
  depositors,
  truncated,
  symbol,
  chainId,
  sourceSplitWarning,
}: {
  depositors: CdpDepositor[];
  truncated: boolean;
  symbol: string;
  chainId: number;
  sourceSplitWarning: string | null;
}) {
  const hasSourceSplitData = depositors.some(
    (depositor) =>
      depositor.cumulativeRebalanceUsed !== undefined &&
      depositor.cumulativeLiquidationUsed !== undefined,
  );

  return (
    <section>
      <DepositorTableIntro
        truncated={truncated}
        sourceSplitWarning={sourceSplitWarning}
      />
      {depositors.length === 0 ? (
        <EmptyBox message="No stability pool LPs indexed yet." />
      ) : (
        <Table>
          <DepositorTableHeader hasSourceSplitData={hasSourceSplitData} />
          <tbody>
            {depositors.map((depositor) => (
              <Row key={depositor.id}>
                <Td className={compactDepositorCellClassName}>
                  <AddressLink address={depositor.address} chainId={chainId} />
                </Td>
                <Td align="right" className={compactDepositorCellClassName}>
                  {formatTokenAmount(depositor.lastTouchedDeposit, symbol)}
                </Td>
                <Td align="right" className={compactDepositorCellClassName}>
                  {formatTokenAmount(depositor.cumulativeDeposited, symbol)}
                </Td>
                <Td align="right" className={compactDepositorCellClassName}>
                  {formatTokenAmount(depositor.cumulativeWithdrawn, symbol)}
                </Td>
                {hasSourceSplitData && (
                  <Td align="right" className={compactDepositorCellClassName}>
                    {depositor.cumulativeRebalanceUsed === undefined
                      ? "Not indexed"
                      : formatSignedWei(
                          depositor.cumulativeRebalanceUsed,
                          symbol,
                        )}
                  </Td>
                )}
                {hasSourceSplitData && (
                  <Td align="right" className={compactDepositorCellClassName}>
                    {depositor.cumulativeLiquidationUsed === undefined
                      ? "Not indexed"
                      : formatSignedWei(
                          depositor.cumulativeLiquidationUsed,
                          symbol,
                        )}
                  </Td>
                )}
                <Td align="right" className={compactDepositorCellClassName}>
                  {formatTokenAmount(depositor.stashedColl, "USDm")}
                </Td>
                <Td align="right" className={compactDepositorCellClassName}>
                  {relativeTime(depositor.lastUpdatedAt)}
                </Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function DepositorTableHeader({
  hasSourceSplitData,
}: {
  hasSourceSplitData: boolean;
}) {
  return (
    <thead>
      <Row>
        <Th className={compactDepositorHeaderClassName}>LP</Th>
        <Th
          align="right"
          className={compactDepositorHeaderClassName}
          title="Deposit at Last LP Update"
        >
          Current Deposit
        </Th>
        <Th
          align="right"
          className={compactDepositorHeaderClassName}
          title="Gross Deposited"
        >
          Deposited (+)
        </Th>
        <Th
          align="right"
          className={compactDepositorHeaderClassName}
          title="Principal Withdrawn"
        >
          Withdrawn (-)
        </Th>
        {hasSourceSplitData && (
          <Th
            align="right"
            className={compactDepositorHeaderClassName}
            title="Rebalance Used"
          >
            Rebalance (-)
          </Th>
        )}
        {hasSourceSplitData && (
          <Th
            align="right"
            className={compactDepositorHeaderClassName}
            title="Liquidation Used"
          >
            Liquidation (-)
          </Th>
        )}
        <Th
          align="right"
          className={compactDepositorHeaderClassName}
          title="Unclaimed Collateral at Last LP Update"
        >
          Coll. Snapshot
        </Th>
        <Th
          align="right"
          className={compactDepositorHeaderClassName}
          title="Snapshot Updated"
        >
          Updated
        </Th>
      </Row>
    </thead>
  );
}

function DepositorTableIntro({
  truncated,
  sourceSplitWarning,
}: {
  truncated: boolean;
  sourceSplitWarning: string | null;
}) {
  return (
    <>
      <h2 className="text-lg font-semibold text-white mb-3">
        Stability Pool LP Snapshots
      </h2>
      <p className="mb-3 text-xs text-muted">
        Rows are last-updated LP snapshots. Current deposit equals gross
        deposited minus principal withdrawn minus debt-token deposit used by CDP
        rebalances and Liquity liquidations, net of retained debt-token yield,
        as of the LP's latest Stability Pool action. Redemptions do not consume
        Stability Pool deposits.
      </p>
      {sourceSplitWarning != null && (
        <p className="mb-3 text-xs text-amber-400" role="status">
          {sourceSplitWarning}
        </p>
      )}
      {truncated && (
        <p className="mb-3 text-xs text-amber-400" role="status">
          Showing the first{" "}
          {CDP_STABILITY_POOL_DEPOSITORS_DETAIL_LIMIT.toLocaleString()} LP
          snapshots by indexed deposit. More snapshots may exist.
        </p>
      )}
    </>
  );
}
