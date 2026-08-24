import { z } from "zod/mini";

export type ExhaustiveSchemaShape<T> = {
  [Field in keyof T]-?: z.ZodMiniType<T[Field]>;
};

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
