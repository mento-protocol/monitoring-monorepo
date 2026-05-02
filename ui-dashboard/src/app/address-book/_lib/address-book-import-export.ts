/**
 * Pure async helpers for the Address Book import/export flow. Handles CSV and
 * JSON file parsing, POST to the import API, anchor-based JSON export, and
 * the `formatImportCounts` utility that turns the server's count payload into
 * a human-readable success message. No React dependency — safe to use from
 * both client components and, in future, server actions.
 */

import { NETWORKS, networkIdForChainId } from "@/lib/networks";

export type ImportedCounts = {
  global: number;
  chains: Record<string, number>;
};

export function formatImportCounts(counts?: ImportedCounts): string {
  if (!counts) return "Imported 0 labels.";
  const parts: string[] = [];
  if (counts.global > 0) {
    parts.push(`${counts.global} global`);
  }
  for (const [chainId, n] of Object.entries(counts.chains)) {
    if (n === 0) continue;
    const id = networkIdForChainId(Number(chainId));
    const label = id ? NETWORKS[id].label : `Chain ${chainId}`;
    parts.push(`${n} ${label}-only`);
  }
  const total =
    counts.global + Object.values(counts.chains).reduce((a, b) => a + b, 0);
  if (parts.length === 0) return "Imported 0 labels.";
  return `Imported ${total} label${total !== 1 ? "s" : ""}: ${parts.join(", ")}.`;
}

/**
 * Reads a File, determines whether it is CSV or JSON, POSTs to the import
 * endpoint, and calls `revalidate` on success.
 *
 * Returns `{ success: <message> }` on success or `{ error: <message> }` on
 * failure. The caller is responsible for surfacing these to the UI.
 */
export async function importFile(
  file: File,
  revalidate: () => Promise<void>,
): Promise<{ success?: string; error?: string }> {
  const isCsv =
    file.name.toLowerCase().endsWith(".csv") ||
    file.type === "text/csv" ||
    (file.type === "text/plain" && file.name.toLowerCase().endsWith(".csv"));

  if (isCsv) {
    try {
      const text = await file.text();
      const res = await fetch("/api/address-labels/import", {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text,
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        return { error: body.error ?? "Import failed." };
      }
      const body = (await res.json()) as { imported?: ImportedCounts };
      await revalidate();
      return { success: formatImportCounts(body.imported) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Import failed." };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return {
      error: "Invalid file. Expected JSON or CSV (address,name,tags,chainId).",
    };
  }

  try {
    const res = await fetch("/api/address-labels/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      return { error: body.error ?? "Import failed." };
    }
    const body = (await res.json()) as { imported?: ImportedCounts };
    await revalidate();
    return { success: formatImportCounts(body.imported) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Import failed." };
  }
}

/**
 * Synthesises a temporary anchor pointing at the export API and triggers a
 * download. No return value — side-effect only.
 */
export function exportLabels(): void {
  const a = document.createElement("a");
  a.href = `/api/address-labels/export`;
  a.download = "";
  a.click();
}
