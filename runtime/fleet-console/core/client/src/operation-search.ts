import type { ConsoleState, OperationNode, TheaterInfo } from "./types.js";

export interface OperationSearchEntry {
  readonly operationId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly operationName: string;
  readonly pluginId: string;
  readonly status: string;
}

export interface OperationSearchGroup {
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly entries: readonly OperationSearchEntry[];
}

const UNASSIGNED_GROUP_KEY = "__unassigned__";

export function buildOperationSearchEntries(current: ConsoleState): readonly OperationSearchEntry[] {
  const theaters = new Map(current.theaters.map((theater) => [theater.id, theater]));
  const entries: OperationSearchEntry[] = [];
  for (const operation of current.operations) {
    if (!operation.theaterId) continue;
    entries.push(toOperationSearchEntry(operation, theaters.get(operation.theaterId)));
  }
  return entries;
}

export function filterOperationSearchEntries(entries: readonly OperationSearchEntry[], query: string): readonly OperationSearchEntry[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = operationSearchText(entry);
    return tokens.every((token) => haystack.includes(token));
  });
}

export function groupOperationSearchEntries(entries: readonly OperationSearchEntry[]): readonly OperationSearchGroup[] {
  const groups: OperationSearchGroup[] = [];
  const groupIndexes = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.theaterId ?? UNASSIGNED_GROUP_KEY;
    const existingIndex = groupIndexes.get(key);
    if (existingIndex !== undefined) {
      const group = groups[existingIndex];
      if (group) groups[existingIndex] = { ...group, entries: [...group.entries, entry] };
      continue;
    }
    groupIndexes.set(key, groups.length);
    groups.push({ theaterId: entry.theaterId, theaterLabel: entry.theaterLabel, entries: [entry] });
  }
  return groups;
}

export function searchTokens(query: string): readonly string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function toOperationSearchEntry(operation: OperationNode, theater: TheaterInfo | undefined): OperationSearchEntry {
  return {
    operationId: operation.id,
    theaterId: operation.theaterId,
    theaterLabel: theater?.label ?? operation.theaterId,
    operationName: operation.renamedTitle ?? operation.title,
    pluginId: operation.pluginId,
    status: typeof operation.state.status === "string" ? operation.state.status : "operation",
  };
}

function operationSearchText(entry: OperationSearchEntry): string {
  return [entry.operationName, entry.theaterLabel, entry.pluginId].join(" ").toLocaleLowerCase();
}
