import { z } from "zod";

// Server-only env vars stay on full Zod and live in a separate module so the
// clientEnv import graph can use zod/mini without retaining full Zod helpers in
// browser chunks. Other server env vars are read at call time in their owning
// modules because their tests use vi.stubEnv() after module initialization.
const serverSchema = z.object({
  VERCEL: z.string().optional(),
  // `.catch(undefined)` so an unexpected runtime value doesn't crash server
  // startup before instrumentation.ts has a chance to skip the Sentry import.
  NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional().catch(undefined),
});

export const serverEnv = serverSchema.parse({
  VERCEL: process.env.VERCEL,
  NEXT_RUNTIME: process.env.NEXT_RUNTIME,
});
