import { indexer as envioIndexer } from "envio";
import { eventLabel, withInstrumentedHandler } from "./performance.js";

type MaybePromise<T> = T | Promise<T>;
type AnyHandler = (args: { context?: unknown }) => MaybePromise<unknown>;
type RegisterHandler = (config: unknown, handler: AnyHandler) => unknown;

function labelPart(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function contractRegisterLabel(config: unknown): string {
  if (typeof config !== "object" || config === null) {
    return "contractRegister:unknown";
  }
  const record = config as Record<string, unknown>;
  const contract = labelPart(record.contract);
  const event =
    typeof record.event === "string" && record.event.length > 0
      ? `.${record.event}`
      : "";
  return `contractRegister:${contract}${event}`;
}

const onEvent = envioIndexer.onEvent as unknown as RegisterHandler;
const contractRegister =
  envioIndexer.contractRegister as unknown as RegisterHandler;
const onBlock = envioIndexer.onBlock as unknown as RegisterHandler;

const wrappedIndexer = {
  name: envioIndexer.name,
  description: envioIndexer.description,
  chainIds: envioIndexer.chainIds,
  chains: envioIndexer.chains,

  onEvent: ((config: unknown, handler: AnyHandler) =>
    onEvent(config, (args) =>
      withInstrumentedHandler(eventLabel(config), args, handler),
    )) as typeof envioIndexer.onEvent,

  contractRegister: ((config: unknown, handler: AnyHandler) =>
    contractRegister(config, (args) =>
      withInstrumentedHandler(contractRegisterLabel(config), args, handler),
    )) as typeof envioIndexer.contractRegister,

  onBlock: ((config: unknown, handler: AnyHandler) =>
    onBlock(config, (args) =>
      withInstrumentedHandler("block", args, handler),
    )) as typeof envioIndexer.onBlock,
} as typeof envioIndexer;

export { wrappedIndexer as indexer };
