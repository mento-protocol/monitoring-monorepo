export type SortDir = "asc" | "desc";
export type OrderByEntry = Partial<Record<string, SortDir>>;

export function buildOrderBy(col: string, dir: SortDir): OrderByEntry[] {
  const primary: OrderByEntry = { [col]: dir };
  if (col === "timestamp") return [primary, { id: "asc" }];
  return [primary, { timestamp: "desc" }, { id: "asc" }];
}
