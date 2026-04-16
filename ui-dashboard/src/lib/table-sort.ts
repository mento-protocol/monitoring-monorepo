export type SortDir = "asc" | "desc";
export type OrderByEntry = Partial<Record<string, SortDir>>;

export function buildOrderBy(
  col: string,
  dir: SortDir,
  secondaryCol?: string,
): OrderByEntry[] {
  const primary: OrderByEntry = { [col]: dir };
  if (!secondaryCol || col === secondaryCol) return [primary, { id: "asc" }];
  return [primary, { [secondaryCol]: "desc" }, { id: "asc" }];
}
