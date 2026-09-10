// This preload is the only transport in CLI tests. Unexpected requests fail closed.
import { appendFileSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const blocked = () => {
  throw new Error("Offline fixture forbids network transport");
};
http.request =
  http.get =
  https.request =
  https.get =
  net.connect =
  net.createConnection =
  tls.connect =
    blocked;
syncBuiltinESMExports();
const scenario = JSON.parse(readFileSync(process.env.TIER1_SCENARIO, "utf8"));
const epoch = 1_800_000_000_000;
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) {
    super(...(args.length ? args : [epoch]));
  }
  static now() {
    return epoch;
  }
};
globalThis.setTimeout = (callback, _delay, ...args) => {
  queueMicrotask(() => callback(...args));
  return 0;
};
let enrichmentIndex = 0;
let pipelineIndex = 0;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  appendFileSync(
    process.env.TIER1_TRANSCRIPT,
    JSON.stringify({ url: target, method: init.method ?? "GET", body }) + "\n",
  );
  const respond = (value, status = 200, headers = {}) =>
    new Response(JSON.stringify(value), { status, headers });
  if (target === "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql") {
    const table = body.query.match(/rows: (\w+)/)?.[1];
    if (
      !table ||
      ![
        "TraderAllTimeAggregate",
        "BrokerTraderAllTimeAggregate",
        "LiquidityPosition",
        "BorrowerInfo",
        "StabilityPoolDepositor",
        "Trove",
        "BridgeBridger",
        "StethPosition",
        "SusdsPosition",
        "OlsLiquidityEvent",
        "LiquidityEvent",
      ].includes(table)
    )
      throw new Error(`Unexpected table ${table}`);
    if (scenario.failedSource === table)
      return respond({ errors: [{ message: "offline discovery failure" }] });
    return respond({
      data: {
        rows: (scenario.sources?.[table] ?? []).slice(
          body.variables.offset,
          body.variables.offset + body.variables.limit,
        ),
      },
    });
  }
  if (target === "https://redis.invalid/hgetall/labels")
    return respond({
      result: Object.entries(scenario.labels ?? {}).flatMap(([key, value]) => [
        key,
        JSON.stringify(value),
      ]),
    });
  if (target === "https://redis.invalid/pipeline") {
    const reply = scenario.pipelines?.[pipelineIndex++];
    if (reply?.status)
      return respond({ message: "offline storage failure" }, reply.status);
    return respond(
      reply?.results ??
        body.map((command) => ({ result: command[0] === "EVAL" ? [] : 1 })),
    );
  }
  if (target === "https://api.arkm.com/subscription/intel-usage")
    return respond(scenario.usage ?? { totalCount: 0, totalLimit: 10000 });
  if (
    /^https:\/\/api\.arkm\.com\/intelligence\/address_enriched\/0x[0-9a-f]{40}\/all\?includeTags=true&includeEntityPredictions=true&includeClusters=false$/.test(
      target,
    )
  ) {
    const reply = scenario.enrichments?.[enrichmentIndex++] ?? {
      data: { ethereum: { arkhamLabel: { name: "Offline label" } } },
    };
    return respond(reply.data ?? {}, reply.status ?? 200, reply.headers ?? {});
  }
  throw new Error(`Unexpected offline request ${target}`);
};
