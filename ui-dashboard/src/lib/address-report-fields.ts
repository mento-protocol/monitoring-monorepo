import type { AddressReport } from "./address-reports-shared";

export const REPORTS_KEY = "reports";

export function encodeReportFields(
  entries: Array<[string, AddressReport]>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [addr, report] of entries) {
    fields[addr.toLowerCase()] = JSON.stringify(report);
  }
  return fields;
}
