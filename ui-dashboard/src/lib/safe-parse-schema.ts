import type { core } from "zod/mini";

/** Structural schema contract shared by full Zod and zod/mini schemas. */
export type SafeParseSchema<T> = {
  safeParse(value: unknown): core.util.SafeParseResult<T>;
};
