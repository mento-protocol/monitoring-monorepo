import process from "node:process";
import { isArkhamSourced } from "./tier1-writes.mjs";
const HASURA_URL = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql";
const PAGE_SIZE = 1000;
const HARD_PAGE_CAP = 250;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export function createDiscovery({
  fetch = globalThis.fetch,
  allowPartialDiscovery = false,
  refresh = true,
  console = globalThis.console,
  exit = process.exit,
} = {}) {
  const DISCOVERY_SOURCES = [
    {
      table: "TraderAllTimeAggregate",
      addressFields: ["trader"],
      volumeField: "volumeUsdWei",
      where: "{ isProtocolActor: { _eq: false } }",
    },
    {
      table: "BrokerTraderAllTimeAggregate",
      addressFields: ["caller"],
      volumeField: "volumeUsdWei",
      where: "{ isProtocolActor: { _eq: false } }",
      brokerTrader: true,
    },
    { table: "LiquidityPosition", addressFields: ["address"] },
    { table: "BorrowerInfo", addressFields: ["address"] },
    { table: "StabilityPoolDepositor", addressFields: ["address"] },
    { table: "Trove", addressFields: ["owner", "previousOwner"] },
    { table: "BridgeBridger", addressFields: ["sender"] },
    { table: "StethPosition", addressFields: ["wallet"] },
    { table: "SusdsPosition", addressFields: ["wallet"] },
    // Event tables, not rollups: page with distinct_on so one row lands per
    // address. `LiquidityEvent.sender` is deliberately absent — it holds the
    // router/pool contract, not the LP.
    {
      table: "OlsLiquidityEvent",
      addressFields: ["caller"],
      distinctOn: "caller",
    },
    {
      table: "LiquidityEvent",
      addressFields: ["recipient"],
      distinctOn: "recipient",
    },
  ];

  const isValidAddress = (v) =>
    typeof v === "string" && /^0x[a-f0-9]{40}$/.test(v);

  async function hasura(query, variables) {
    const res = await fetch(HASURA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Hasura ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (body.errors)
      throw new Error(`Hasura errors: ${JSON.stringify(body.errors)}`);
    return body.data;
  }

  async function pageSource(source) {
    const { table, addressFields, volumeField, where, distinctOn } = source;
    const selection = [...addressFields, ...(volumeField ? [volumeField] : [])];
    // distinct_on requires order_by to lead with the same column; plain rollup
    // pages order by the primary key so offset stepping is stable.
    const orderField = distinctOn ?? "id";
    const clauses = [
      where ? `where: ${where}` : "",
      distinctOn ? `distinct_on: [${distinctOn}]` : "",
      `order_by: { ${orderField}: asc }`,
      "limit: $limit",
      "offset: $offset",
    ].filter(Boolean);
    const query = `query Q($limit: Int!, $offset: Int!) {
      rows: ${table}(
        ${clauses.join("\n        ")}
      ) {
        ${selection.join("\n        ")}
      }
    }`;

    const out = [];
    for (let page = 0; page < HARD_PAGE_CAP; page++) {
      const data = await hasura(query, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      const rows = data.rows ?? [];
      out.push(...rows);
      if (rows.length < PAGE_SIZE) return { rows: out, capped: false };
    }
    return { rows: out, capped: true };
  }

  async function discoverAll() {
    console.log("→ Discovery from per-address rollups (all chains)...");
    const registry = new Map(); // address → { sources, volumeWei, nonBroker }
    const failedSources = [];
    const perSource = {}; // "Table.field" → distinct address count
    for (const source of DISCOVERY_SOURCES) {
      for (const field of source.addressFields) {
        perSource[`${source.table}.${field}`] = 0;
      }
      try {
        const { rows, capped } = await pageSource(source);
        for (const row of rows) {
          const volume = source.volumeField
            ? BigInt(row[source.volumeField] ?? "0")
            : 0n;
          for (const field of source.addressFields) {
            const address = row[field]?.toLowerCase();
            if (!isValidAddress(address) || address === ZERO_ADDRESS) continue;
            const key = `${source.table}.${field}`;
            let rec = registry.get(address);
            if (!rec) {
              rec = { sources: [], volumeWei: 0n, nonBroker: false };
              registry.set(address, rec);
            }
            if (!rec.sources.includes(key)) {
              rec.sources.push(key);
              perSource[key]++;
            }
            // Sum: TraderAllTimeAggregate is per (chainId, trader), and the same
            // address can trade on both the v3 and v2 Broker paths.
            rec.volumeWei += volume;
            if (!source.brokerTrader) rec.nonBroker = true;
          }
        }
        const counted = source.addressFields
          .map((f) => `${f}=${perSource[`${source.table}.${f}`]}`)
          .join(" ");
        console.log(
          `  ${source.table}: ${rows.length} rows → ${counted}${
            capped ? " ⚠ HARD_PAGE_CAP hit — truncated" : ""
          }`,
        );
        // A capped source is exactly as incomplete as an errored one — silently
        // sweeping a truncated registry defeats the abort-on-partial-discovery
        // guarantee this function otherwise enforces.
        if (capped) failedSources.push(source.table);
      } catch (err) {
        console.warn(`  ⚠ ${source.table}: ${err.message}`);
        failedSources.push(source.table);
        for (const field of source.addressFields) {
          perSource[`${source.table}.${field}`] = `ERROR: ${err.message}`;
        }
      }
    }
    // A failed source silently shrinks the sweep — quota spent against an
    // incomplete discovery set looks identical to full coverage afterwards.
    // Abort instead, unless the caller explicitly accepted the gap.
    if (failedSources.length > 0 && !allowPartialDiscovery) {
      console.error(
        `✗ Discovery incomplete — ${failedSources.length} source(s) failed: ` +
          `${failedSources.join(", ")}. Re-run, or pass ` +
          `--allow-partial-discovery to enrich the partial set anyway.`,
      );
      exit(1);
    }
    console.log(`→ Discovery total (deduped): ${registry.size} addresses`);
    return { registry, perSource };
  }

  /**
   * Order the work: arkham-sourced refreshes first, then everything discovered
   * outside the Broker trader rollup, then Broker traders by lifetime USD volume
   * descending. Manually-labeled addresses drop out entirely.
   */
  function buildQueue(registry, existing) {
    const queue = [];
    const seen = new Set();
    let manualSkipped = 0;
    let labeledSkipped = 0;

    if (refresh) {
      const refreshTier = Object.entries(existing)
        .filter(
          ([address, entry]) =>
            isValidAddress(address) && isArkhamSourced(entry),
        )
        .map(([address]) => address)
        .sort();
      for (const address of refreshTier) {
        const rec = registry.get(address);
        queue.push({
          address,
          tier: "refresh",
          sources: rec?.sources ?? ["labels:arkham"],
          volumeWei: rec?.volumeWei ?? 0n,
        });
        seen.add(address);
      }
    }

    const discovery = [];
    const brokerTraders = [];
    for (const [address, rec] of registry) {
      if (seen.has(address)) continue;
      const current = existing[address];
      if (current) {
        if (isArkhamSourced(current)) labeledSkipped++;
        else manualSkipped++;
        continue;
      }
      const item = {
        address,
        tier: rec.nonBroker ? "discovery" : "broker-trader",
        sources: rec.sources,
        volumeWei: rec.volumeWei,
      };
      (rec.nonBroker ? discovery : brokerTraders).push(item);
    }

    // Volume desc, address asc as the tie-break so the order is reproducible
    // across runs (needed for resume to line up with the prior run's progress).
    const byVolume = (a, b) => {
      if (a.volumeWei !== b.volumeWei)
        return a.volumeWei > b.volumeWei ? -1 : 1;
      return a.address < b.address ? -1 : 1;
    };
    discovery.sort(byVolume);
    brokerTraders.sort(byVolume);

    queue.push(...discovery, ...brokerTraders);
    return {
      queue,
      tiers: {
        refresh: queue.length - discovery.length - brokerTraders.length,
        discovery: discovery.length,
        brokerTrader: brokerTraders.length,
      },
      manualSkipped,
      labeledSkipped,
    };
  }

  return { discoverAll, pageSource, buildQueue };
}
