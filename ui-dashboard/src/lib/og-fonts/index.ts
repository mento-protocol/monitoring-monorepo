import { readFile } from "node:fs/promises";
import type { ImageResponse } from "next/og";

/**
 * Geist for the Open Graph cards.
 *
 * Every card declared `fontFamily: "Geist"` and silently rendered in Satori's
 * bundled fallback, because nothing passed a `fonts` array to `ImageResponse`.
 * The repo's browser font is `geist-latin.woff2` and Satori cannot parse woff2
 * at all — so these are the plain-woff cuts of the same family, which it can.
 *
 * With no face loaded the fallback ships a single weight, so `fontWeight` was
 * inert and every card's weight-based hierarchy collapsed to one flat tone.
 *
 * Read with `readFile` over a `new URL(..., import.meta.url)` file URL, not
 * `fetch`: these routes run on the Node runtime, where `fetch` rejects the
 * `file:` scheme outright. The URL form is still what the bundler traces, so
 * the woff lands in the serverless function next to the route — a
 * `process.cwd()` path resolves in `next dev` and then 404s in production.
 */
const FACES = [
  { weight: 400 as const, file: "geist-sans-latin-400-normal.woff" },
  { weight: 600 as const, file: "geist-sans-latin-600-normal.woff" },
  { weight: 700 as const, file: "geist-sans-latin-700-normal.woff" },
  { weight: 800 as const, file: "geist-sans-latin-800-normal.woff" },
];

type ImageResponseOptions = NonNullable<
  ConstructorParameters<typeof ImageResponse>[1]
>;
export type OgFont = NonNullable<ImageResponseOptions["fonts"]>[number];

// Module-scoped so a warm lambda reads each face once rather than per render.
// Kept as the promise, not the resolved value, so concurrent first renders
// share one read instead of racing four.
let cached: Promise<OgFont[] | undefined> | null = null;

async function readFaces(): Promise<OgFont[]> {
  return Promise.all(
    FACES.map(async ({ weight, file }) => ({
      name: "Geist",
      data: await readFile(new URL(`./${file}`, import.meta.url)),
      weight,
      style: "normal" as const,
    })),
  );
}

/**
 * Spread into `ImageResponse` options: `{ fonts }` when the faces loaded, and
 * `{}` when they did not.
 *
 * Failing open is deliberate: a card in the fallback face is worse-looking,
 * while a card that throws serves no image at all and unfurls as a broken
 * link. The typeface is not worth that trade.
 *
 * Two distinctions the type system and Satori each enforce one half of. An
 * empty array is not "no preference" — Satori rejects it with "No fonts are
 * loaded. At least one font is required to calculate the layout", so `[]`
 * would turn a cosmetic failure into a 500. And under
 * `exactOptionalPropertyTypes`, `{ fonts: undefined }` is not the same as
 * omitting the key, so the caller has to spread rather than assign.
 */
export async function ogFontOptions(): Promise<{ fonts?: OgFont[] }> {
  cached ??= readFaces().catch((error: unknown) => {
    cached = null;
    console.error("OG font load failed; falling back to Satori's face", error);
    return undefined;
  });
  const fonts = await cached;
  return fonts ? { fonts } : {};
}
