import { createEffect as createEnvioEffect } from "envio";
import { trackEffectExecution } from "../performance.js";

type UntypedCreateEffect = (
  options: unknown,
  handler: (args: unknown) => Promise<unknown>,
) => unknown;

/** Envio effect factory with the repo's optional performance instrumentation. */
export const createEffect = ((options: unknown, handler: unknown) => {
  const effectName =
    typeof options === "object" &&
    options !== null &&
    "name" in options &&
    typeof (options as { name?: unknown }).name === "string"
      ? (options as { name: string }).name
      : "unknown";

  return (createEnvioEffect as unknown as UntypedCreateEffect)(
    options,
    (args) =>
      trackEffectExecution(effectName, () =>
        (handler as (value: unknown) => Promise<unknown>)(args),
      ),
  );
}) as typeof createEnvioEffect;
