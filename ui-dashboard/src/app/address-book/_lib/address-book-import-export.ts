import { NETWORKS, networkIdForChainId } from "@/lib/networks";
import type { ImportedCounts } from "@/lib/address-labels-shared";

function formatImportCounts(counts?: ImportedCounts): string {
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

async function postImport(
  contentType: string,
  body: BodyInit,
): Promise<{ success?: string; error?: string }> {
  try {
    const res = await fetch("/api/address-labels/import", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    const json = (await res.json()) as {
      error?: string;
      imported?: ImportedCounts;
    };
    if (!res.ok) {
      return { error: json.error ?? "Import failed." };
    }
    return { success: formatImportCounts(json.imported) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Import failed." };
  }
}

export async function importFile(
  file: File,
  revalidate: () => Promise<void>,
): Promise<{ success?: string; error?: string }> {
  const isCsv =
    file.name.toLowerCase().endsWith(".csv") ||
    file.type === "text/csv" ||
    (file.type === "text/plain" && file.name.toLowerCase().endsWith(".csv"));

  let result: { success?: string; error?: string };
  if (isCsv) {
    result = await postImport("text/csv", await file.text());
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return {
        error:
          "Invalid file. Expected JSON or CSV (address,name,tags,chainId).",
      };
    }
    result = await postImport("application/json", JSON.stringify(parsed));
  }

  if (result.success) {
    // Catch here so a refetch failure on a successful import surfaces as
    // an error to the caller — the data did land server-side, but the
    // user needs to know the table is stale until they reload.
    try {
      await revalidate();
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Import failed." };
    }
  }
  return result;
}

export function exportLabels(): void {
  const a = document.createElement("a");
  a.href = `/api/address-labels/export`;
  a.download = "";
  a.click();
}
