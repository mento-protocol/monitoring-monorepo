import { indexer as envioIndexer } from "envio";
import { eventLabel, withInstrumentedHandler } from "./performance.js";

type AnyHandler = (args: { context?: unknown }) => unknown | Promise<unknown>;
type RegisterHandler = (config: unknown, handler: AnyHandler) => unknown;

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
      withInstrumentedHandler(
        `contractRegister:${eventLabel(config)}`,
        args,
        handler,
      ),
    )) as typeof envioIndexer.contractRegister,

  onBlock: ((config: unknown, handler: AnyHandler) =>
    onBlock(config, (args) =>
      withInstrumentedHandler("block", args, handler),
    )) as typeof envioIndexer.onBlock,
} as typeof envioIndexer;

export { wrappedIndexer as indexer };
