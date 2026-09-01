export type ArchiveFilter = "current" | "archived" | "all";

export interface ListPageInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly archive?: ArchiveFilter;
}

export interface ListPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface NormalizedListPageInput {
  readonly page: number;
  readonly pageSize: number;
  readonly search: string;
  readonly archive: ArchiveFilter;
  readonly offset: number;
}

export function normalizeListPageInput(input: ListPageInput): NormalizedListPageInput {
  const page = boundedInteger(input.page ?? 1, "page", 1, 100_000);
  const pageSize = boundedInteger(input.pageSize ?? 20, "pageSize", 1, 100);
  const search = (input.search ?? "").trim();
  if (search.length > 120) throw new Error("search exceeds 120 characters");
  const archive = input.archive ?? "current";
  if (archive !== "current" && archive !== "archived" && archive !== "all") {
    throw new Error("archive must be current, archived or all");
  }
  return { page, pageSize, search, archive, offset: (page - 1) * pageSize };
}

export function literalLikePattern(search: string): string {
  return `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
