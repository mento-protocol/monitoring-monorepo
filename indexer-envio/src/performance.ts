type AnyHandler = (args: { context?: unknown }) => unknown | Promise<unknown>;
type AnyContext = Record<PropertyKey, unknown>;
type AnyFunction = (...args: unknown[]) => unknown;

type HandlerStats = {
  calls: number;
  preloadCalls: number;
  processCalls: number;
  totalMs: number;
  maxMs: number;
};

type EffectStats = {
  requests: number;
  executions: number;
  totalMs: number;
  maxMs: number;
};

type EntityStats = {
  get: number;
  getWhere: number;
  getOrCreate: number;
  getOrThrow: number;
  set: number;
  deleteUnsafe: number;
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_LOG_INTERVAL = 10_000;
const MAX_TRACKED_STAT_KEYS = 256;
const OVERFLOW_STAT_KEY = "__overflow__";

const enabled = TRUE_VALUES.has((process.env.INDEXER_PERF ?? "").toLowerCase());
const logInterval = Math.max(
  1,
  Number(process.env.INDEXER_PERF_LOG_INTERVAL_EVENTS ?? DEFAULT_LOG_INTERVAL),
);

const handlerStats = new Map<string, HandlerStats>();
const effectStats = new Map<string, EffectStats>();
const entityStats = new Map<string, EntityStats>();

let processedHandlerCalls = 0;

function nowMs(): number {
  return performance.now();
}

function trackedStatKey<T>(stats: Map<string, T>, name: string): string {
  if (stats.has(name) || stats.size < MAX_TRACKED_STAT_KEYS) return name;
  return OVERFLOW_STAT_KEY;
}

function getHandlerStats(name: string): HandlerStats {
  const key = trackedStatKey(handlerStats, name);
  const existing = handlerStats.get(key);
  if (existing) return existing;
  const created = {
    calls: 0,
    preloadCalls: 0,
    processCalls: 0,
    totalMs: 0,
    maxMs: 0,
  };
  handlerStats.set(key, created);
  return created;
}

function getEffectStats(name: string): EffectStats {
  const key = trackedStatKey(effectStats, name);
  const existing = effectStats.get(key);
  if (existing) return existing;
  const created = { requests: 0, executions: 0, totalMs: 0, maxMs: 0 };
  effectStats.set(key, created);
  return created;
}

function getEntityStats(name: string): EntityStats {
  const key = trackedStatKey(entityStats, name);
  const existing = entityStats.get(key);
  if (existing) return existing;
  const created = {
    get: 0,
    getWhere: 0,
    getOrCreate: 0,
    getOrThrow: 0,
    set: 0,
    deleteUnsafe: 0,
  };
  entityStats.set(key, created);
  return created;
}

function topEntries<T>(
  stats: Map<string, T>,
  score: (value: T) => number,
  format: (name: string, value: T) => string,
): string {
  return Array.from(stats.entries())
    .sort((a, b) => score(b[1]) - score(a[1]))
    .slice(0, 5)
    .map(([name, value]) => format(name, value))
    .join(", ");
}

function buildSummary(): string {
  const handlers = topEntries(
    handlerStats,
    (value) => value.totalMs,
    (name, value) =>
      `${name} n=${value.calls} avg=${(value.totalMs / value.calls).toFixed(
        1,
      )}ms max=${value.maxMs.toFixed(1)}ms`,
  );
  const effects = topEntries(
    effectStats,
    (value) => value.requests + value.executions,
    (name, value) => {
      const estimatedHits = Math.max(0, value.requests - value.executions);
      const avg = value.executions === 0 ? 0 : value.totalMs / value.executions;
      return `${name} req=${value.requests} exec=${value.executions} hit~=${estimatedHits} avg=${avg.toFixed(
        1,
      )}ms`;
    },
  );
  const entities = topEntries(
    entityStats,
    (value) =>
      value.get +
      value.getWhere +
      value.getOrCreate +
      value.getOrThrow +
      value.set +
      value.deleteUnsafe,
    (name, value) =>
      `${name} get=${value.get} getWhere=${value.getWhere} set=${value.set}`,
  );

  return [
    `[perf] processed=${processedHandlerCalls}`,
    `handlers=[${handlers}]`,
    `effects=[${effects}]`,
    `entities=[${entities}]`,
  ].join(" ");
}

function effectName(effect: unknown): string {
  if (
    typeof effect === "object" &&
    effect !== null &&
    "name" in effect &&
    typeof (effect as { name?: unknown }).name === "string"
  ) {
    return (effect as { name: string }).name;
  }
  return "unknown";
}

function isEntityOperations(
  value: unknown,
): value is Record<string, AnyFunction> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.get === "function" ||
    typeof record.getWhere === "function" ||
    typeof record.set === "function"
  );
}

function wrapEntityOperations(
  entityName: string,
  operations: Record<string, AnyFunction>,
): Record<string, unknown> {
  return new Proxy(operations, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const opName = String(prop) as keyof EntityStats;
      if (
        typeof value !== "function" ||
        ![
          "get",
          "getWhere",
          "getOrCreate",
          "getOrThrow",
          "set",
          "deleteUnsafe",
        ].includes(opName)
      ) {
        return value;
      }

      return (...args: unknown[]) => {
        getEntityStats(entityName)[opName] += 1;
        return value.apply(target, args);
      };
    },
  });
}

function instrumentContext<T extends AnyContext>(context: T): T {
  const entityProxyCache = new WeakMap<object, object>();
  return new Proxy(context, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "effect" && typeof value === "function") {
        return (effect: unknown, input: unknown) => {
          getEffectStats(effectName(effect)).requests += 1;
          return value.call(target, effect, input);
        };
      }
      if (isEntityOperations(value)) {
        const cached = entityProxyCache.get(value);
        if (cached) return cached;
        const wrapped = wrapEntityOperations(String(prop), value);
        entityProxyCache.set(value, wrapped);
        return wrapped;
      }
      return value;
    },
  });
}

export async function withInstrumentedHandler(
  name: string,
  args: { context?: unknown },
  handler: AnyHandler,
): Promise<unknown> {
  if (!enabled || typeof args.context !== "object" || args.context === null) {
    return handler(args);
  }

  const context = args.context as AnyContext;
  const isPreload = context.isPreload === true;
  const instrumentedArgs = {
    ...args,
    context: instrumentContext(context),
  };
  const start = nowMs();
  try {
    return await handler(instrumentedArgs);
  } finally {
    const elapsed = nowMs() - start;
    const stats = getHandlerStats(name);
    stats.calls += 1;
    stats.totalMs += elapsed;
    stats.maxMs = Math.max(stats.maxMs, elapsed);
    if (isPreload) {
      stats.preloadCalls += 1;
    } else {
      stats.processCalls += 1;
      processedHandlerCalls += 1;
      if (processedHandlerCalls % logInterval === 0) {
        const log = context.log as { info?: (message: string) => void };
        log.info?.(buildSummary());
      }
    }
  }
}

export async function trackEffectExecution<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!enabled) return run();
  const start = nowMs();
  try {
    return await run();
  } finally {
    const elapsed = nowMs() - start;
    const stats = getEffectStats(name);
    stats.executions += 1;
    stats.totalMs += elapsed;
    stats.maxMs = Math.max(stats.maxMs, elapsed);
  }
}

export function eventLabel(config: unknown): string {
  if (typeof config !== "object" || config === null) return "event:unknown";
  const record = config as Record<string, unknown>;
  const contract = String(record.contract ?? "unknown");
  const event = String(record.event ?? "unknown");
  return `${contract}.${event}`;
}
