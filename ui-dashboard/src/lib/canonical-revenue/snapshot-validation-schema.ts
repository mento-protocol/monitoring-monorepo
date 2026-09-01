import { z } from "zod/mini";
import { SECONDS_PER_DAY } from "@/lib/time-series";

export type ExhaustiveSchemaShape<T> = {
  [Field in keyof T]-?: z.ZodMiniType<T[Field]>;
};

export function matchesSampledUtcDay(value: {
  timestamp: string;
  sampledAtTimestamp: string;
}): boolean {
  try {
    const sampledAt = BigInt(value.sampledAtTimestamp.trim());
    const secondsPerDay = BigInt(SECONDS_PER_DAY);
    return (
      BigInt(value.timestamp.trim()) === sampledAt - (sampledAt % secondsPerDay)
    );
  } catch {
    return false;
  }
}

export const nonemptyStringSchema = z
  .string()
  .check(z.refine((value) => value.trim() !== ""));

export const integerStringSchema = z
  .string()
  .check(z.refine((value) => /^-?\d+$/.test(value.trim())));

export const nonnegativeIntegerStringSchema = z
  .string()
  .check(z.refine((value) => /^\d+$/.test(value.trim())));

export const positiveIntegerStringSchema = z
  .string()
  .check(z.refine((value) => /^0*[1-9]\d*$/.test(value.trim())));

export const safePositiveIntegerStringSchema =
  positiveIntegerStringSchema.check(
    z.refine((value) => Number.isSafeInteger(Number(value))),
  );
