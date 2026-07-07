import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.join(process.cwd(), "src");
const GLOBALS_CSS = path.join(SRC_ROOT, "app", "globals.css");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const SURFACE_COLORS = [
  ["body slate-900", "#0f172a"],
  ["deep card slate-900", "#111827"],
  ["card slate-800", "#1e293b"],
  ["raised slate-700", "#334155"],
] as const;

function srgbToLinear(value: number) {
  const channel = value / 255;
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const [, red, green, blue] =
    /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? [];
  if (!red || !green || !blue) {
    throw new Error(`Unsupported color: ${hex}`);
  }

  return (
    0.2126 * srgbToLinear(Number.parseInt(red, 16)) +
    0.7152 * srgbToLinear(Number.parseInt(green, 16)) +
    0.0722 * srgbToLinear(Number.parseInt(blue, 16))
  );
}

function contrastRatio(foreground: string, background: string) {
  const fg = luminance(foreground);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) return listSourceFiles(fullPath);
    return SOURCE_EXTENSIONS.has(path.extname(entry)) ? [fullPath] : [];
  });
}

describe("muted text contrast", () => {
  it("keeps the dashboard muted text token AA-compliant on slate surfaces", () => {
    const css = readFileSync(GLOBALS_CSS, "utf8");
    const token = /--color-muted:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
    expect(token).toBeTruthy();

    for (const [surface, background] of SURFACE_COLORS) {
      expect(contrastRatio(token!, background), surface).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("does not reintroduce the failing slate secondary text utilities", () => {
    const failingUtilityPattern = new RegExp(
      `\\b(?:text|placeholder)-slate-(${[500, 600].join("|")})\\b`,
    );
    const offenders = listSourceFiles(SRC_ROOT).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return failingUtilityPattern.test(source)
        ? [path.relative(SRC_ROOT, file)]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});
