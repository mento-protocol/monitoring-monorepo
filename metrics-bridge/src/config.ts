const DEFAULT_HASURA_URL = "https://indexer.hyperindex.xyz/2f3dd15/v1/graphql";

export const HASURA_URL = process.env.HASURA_URL || DEFAULT_HASURA_URL;

const rawPollInterval = Number(process.env.POLL_INTERVAL_MS || "30000");
export const POLL_INTERVAL_MS =
  Number.isFinite(rawPollInterval) && rawPollInterval >= 1000
    ? rawPollInterval
    : 30000;

const rawPort = Number(process.env.PORT || "8080");
export const PORT =
  Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 8080;
